import { Worker } from 'worker_threads'
import { spawn } from 'child_process'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import utils from './utils.js'
import Camera from '../devices/camera.js'
import {
    KiBurstController,
    KI_BURST_FRAME_COUNT,
    KI_BURST_INTERVAL_MS,
    KI_BURST_OBSERVATION_WINDOW_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from './ki-burst-controller.js'

const patched = new WeakSet()
const originalPublishDiscovery = Camera.prototype.publishDiscovery
const originalPublishState = Camera.prototype.publishState
const originalInitAttributeEntities = Camera.prototype.initAttributeEntities
const originalProcessCommand = Camera.prototype.processCommand

export function homeAssistantSlug(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_')
}

function clearAutoOff(camera) {
    if (camera.data?.auto_off?.timer) {
        clearTimeout(camera.data.auto_off.timer)
        camera.data.auto_off.timer = null
    }
}

function stopKeepalive(camera) {
    const keepalive = camera.data?.stream?.keepalive
    if (!keepalive) return
    keepalive.generation = (keepalive.generation || 0) + 1
    if (keepalive.timer) {
        clearTimeout(keepalive.timer)
        keepalive.timer = null
    }
    const session = keepalive.session
    keepalive.session = false
    keepalive.active = false
    keepalive.expires = 0
    if (session && typeof session.kill === 'function') {
        try { session.kill('SIGTERM') } catch {}
    }
}

function invalidateLiveRequest(camera) {
    camera.liveRequestGeneration = (camera.liveRequestGeneration || 0) + 1
    camera.activeLiveRequestId = null
    if (camera.data?.stream?.live) {
        camera.data.stream.live.pendingOnDemandUrl = null
        camera.data.stream.live.pendingOnDemandAt = 0
    }
}

function publishBurstState(camera, status, details = {}) {
    if (!camera.data?.ki_burst) return
    camera.data.ki_burst.status = status

    const attrs = {
        status,
        burstId: details.burstId || camera.data.ki_burst.burstId || null,
        frameCount: details.frameCount || (status === 'complete' ? KI_BURST_FRAME_COUNT : 0),
        intervalMs: details.intervalMs || KI_BURST_INTERVAL_MS,
        capturedAt: details.capturedAt || null,
        frameOffsetsMs: details.frameOffsetsMs || [],
        paths: details.paths || [],
        selectionMode: details.selectionMode || null,
        observationWindowMs: Number.isFinite(details.observationWindowMs) ? details.observationWindowMs : null,
        candidateFramesEvaluated: Number.isInteger(details.candidateFramesEvaluated) ? details.candidateFramesEvaluated : 0,
        actualFrameOffsetsMs: Array.isArray(details.actualFrameOffsetsMs) ? details.actualFrameOffsetsMs : [],
        differenceScores: Array.isArray(details.differenceScores) ? details.differenceScores : [],
        changedBlockRatios: Array.isArray(details.changedBlockRatios) ? details.changedBlockRatios : [],
        pairwiseDifferenceScores: Array.isArray(details.pairwiseDifferenceScores) ? details.pairwiseDifferenceScores : [],
        totalDiversityScore: Number.isFinite(details.totalDiversityScore) ? details.totalDiversityScore : null,
        selectionReasons: Array.isArray(details.selectionReasons) ? details.selectionReasons : [],
        selectionThreshold: Number.isFinite(details.selectionThreshold) ? details.selectionThreshold : null,
        minimumSelectionSeparationMs: Number.isFinite(details.minimumSelectionSeparationMs) ? details.minimumSelectionSeparationMs : KI_BURST_INTERVAL_MS,
        firstCleanFrameAt: details.firstCleanFrameAt || null,
        totalBurstDurationMs: Number.isFinite(details.totalBurstDurationMs) ? details.totalBurstDurationMs : null,
        frameSourceIndices: Array.isArray(details.frameSourceIndices) ? details.frameSourceIndices : [],
        framePts: Array.isArray(details.framePts) ? details.framePts : [],
        framePtsTime: Array.isArray(details.framePtsTime) ? details.framePtsTime : [],
        frameTimestamps: Array.isArray(details.frameTimestamps) ? details.frameTimestamps : [],
        frameTypes: Array.isArray(details.frameTypes) ? details.frameTypes : [],
        frameRawChecksums: Array.isArray(details.frameRawChecksums) ? details.frameRawChecksums : [],
        frameHashes: Array.isArray(details.frameHashes) ? details.frameHashes : [],
        rtpIntegrity: details.rtpIntegrity && typeof details.rtpIntegrity === 'object' ? details.rtpIntegrity : {},
        ...(details.error ? { error: details.error } : {})
    }

    camera.data.ki_burst.burstId = attrs.burstId
    camera.data.ki_burst.attributes = attrs

    if (status === 'complete' && Array.isArray(details.frames) && details.frames.length === KI_BURST_FRAME_COUNT) {
        camera.data.ki_burst.frames = details.frames
        details.frames.forEach((frame, index) => {
            const entity = camera.entity?.[`ki_burst_frame_${index + 1}`]
            if (entity?.topic) camera.mqttPublish(entity.topic, frame, 'mqtt', '<binary_image_data>')
        })
    }

    const entity = camera.entity?.ki_burst_status
    if (entity?.state_topic) {
        camera.mqttPublish(entity.state_topic, status)
        if (entity.json_attributes_topic) {
            camera.mqttPublish(entity.json_attributes_topic, JSON.stringify(attrs), 'attr')
        }
    }
}

function attachBuild12Worker(camera) {
    const oldWorker = camera.data.stream.live.worker
    try {
        oldWorker?.removeAllListeners?.('message')
        oldWorker?.postMessage?.({ command: 'stop', reason: 'build12-worker-replace' })
        oldWorker?.terminate?.().catch?.(() => {})
    } catch {}

    const worker = new Worker(new URL('../devices/camera-livestream-build12.js', import.meta.url), {
        workerData: {
            doorbotId: camera.device.id,
            deviceName: camera.deviceData.name
        }
    })
    camera.data.stream.live.worker = worker

    camera.kiBurstController = new KiBurstController({
        requestTicket: async () => {
            const response = await camera.device.restClient.request({
                method: 'POST',
                url: 'https://app.ring.com/api/v1/clap/ticket/request/signalsocket'
            })
            if (!response?.ticket) throw new Error('Ring did not return a WebRTC signaling ticket')
            return response.ticket
        },
        sendWorker: message => worker.postMessage(message),
        onState: (status, details) => publishBurstState(camera, status, details)
    })

    worker.on('message', message => {
        if (camera.kiBurstController.handleWorkerMessage(message)) return

        if (message.type === 'state' && message.kind === 'live') {
            // A callback from an older worker session can never change the current session state.
            if (message.requestId !== camera.activeLiveRequestId) return

            if (message.data === 'active') {
                camera.data.stream.live.status = 'active'
                camera.data.stream.live.session = true
                camera.rescheduleAutoOff()
            } else if (message.data === 'inactive') {
                camera.data.stream.live.status = 'inactive'
                camera.data.stream.live.session = false
                camera.activeLiveRequestId = null
                clearAutoOff(camera)
            } else if (message.data === 'failed') {
                camera.data.stream.live.status = 'failed'
                camera.data.stream.live.session = false
                camera.activeLiveRequestId = null
                clearAutoOff(camera)
            }
            camera.publishStreamState()
            return
        }

        if (message.type === 'log_info') camera.debug(message.data, 'wrtc')
        if (message.type === 'log_error') camera.debug(message.data, 'wrtc')
    })

    worker.on('error', error => {
        camera.debug(`Build-12 live worker error: ${error?.stack || error?.message || error}`, 'wrtc')
        if (camera.activeLiveRequestId !== null) {
            camera.data.stream.live.status = 'failed'
            camera.data.stream.live.session = false
            camera.activeLiveRequestId = null
            camera.publishStreamState()
        }
        camera.kiBurstController.cancel('Build-12 live worker crashed')
    })
}

function ensureBuild12(camera) {
    if (patched.has(camera)) return
    if (!camera?.data?.stream?.live || !camera?.entity) return

    camera.liveRequestGeneration = 0
    camera.activeLiveRequestId = null
    camera.data.ki_burst = {
        status: 'idle',
        burstId: null,
        frames: [null, null, null],
        attributes: { status: 'idle', frameCount: 0, intervalMs: KI_BURST_INTERVAL_MS }
    }

    camera.entity.ki_burst = {
        component: 'button',
        name: 'KI Burst (3 Frames)',
        icon: 'mdi:camera-burst'
    }
    camera.entity.ki_burst_frame_1 = { component: 'camera', name: 'KI Burst Frame 1' }
    camera.entity.ki_burst_frame_2 = { component: 'camera', name: 'KI Burst Frame 2' }
    camera.entity.ki_burst_frame_3 = { component: 'camera', name: 'KI Burst Frame 3' }
    camera.entity.ki_burst_status = {
        component: 'sensor',
        name: 'KI Burst Status',
        icon: 'mdi:image-multiple',
        attributes: true
    }

    attachBuild12Worker(camera)
    patched.add(camera)
}

Camera.prototype.initAttributeEntities = async function(...args) {
    const result = await originalInitAttributeEntities.apply(this, args)
    const slug = homeAssistantSlug(this.device?.name)
    const host = process.env.RUNMODE === 'addon' ? (process.env.HAHOSTNAME || 'localhost') : 'localhost'
    if (slug && this.data?.stream?.live) {
        this.data.stream.live.stillImageURL = `https://${host}:8123{{ states.camera.${slug}_snapshot.attributes.entity_picture }}`
    }
    return result
}

Camera.prototype.publishDiscovery = async function(...args) {
    ensureBuild12(this)
    return originalPublishDiscovery.apply(this, args)
}

Camera.prototype.publishState = async function() {
    ensureBuild12(this)
    const result = await originalPublishState.apply(this, arguments)
    if (arguments[0] === undefined && this.entity?.ki_burst_status?.state_topic) {
        publishBurstState(this, this.data.ki_burst.status, this.data.ki_burst.attributes)
        this.data.ki_burst.frames.forEach((frame, index) => {
            const entity = this.entity[`ki_burst_frame_${index + 1}`]
            if (frame && entity?.topic) this.mqttPublish(entity.topic, frame, 'mqtt', '<binary_image_data>')
        })
    }
    return result
}

Camera.prototype.processCommand = function(command, message) {
    ensureBuild12(this)
    if (command === 'ki_burst/command') {
        if (String(message).toLowerCase() === 'press') this.takeKiBurst()
        else this.debug(`Received invalid KI Burst command: ${message}`)
        return
    }
    return originalProcessCommand.call(this, command, message)
}

Camera.prototype.setSnapshotMode = function(message) {
    this.debug(`Received set snapshot mode to ${message}`)
    const snapshotMode = message.toLowerCase().replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase())

    if (this.entity.snapshot_mode.options.includes(snapshotMode)) {
        this.data.snapshot.mode = snapshotMode
        this.data.snapshot.autoInterval = snapshotMode === 'Auto' ? true : this.data.snapshot.autoInterval
        this.updateSnapshotMode()
        this.publishSnapshotMode()

        if (snapshotMode === 'Auto') {
            this.debug(`Snapshot mode has been set to ${snapshotMode}, resetting to default values for camera type`)
            clearInterval(this.data.snapshot.intervalTimerId)
            this.scheduleSnapshotRefresh()
            this.publishSnapshotInterval()
        } else {
            this.debug(`Snapshot mode has been set to ${snapshotMode}`)
        }
        this.updateDeviceState()
    } else {
        this.debug('Received invalid command for snapshot mode')
    }
}

Camera.prototype.startLiveStream = async function(rtspPublishUrl) {
    ensureBuild12(this)
    if (this.data.live_allow.state !== 'ON' || this.kiBurstController.running) return

    const generation = ++this.liveRequestGeneration
    const requestId = generation
    this.activeLiveRequestId = requestId

    let ticket
    try {
        this.debug('Acquiring a live stream WebRTC signaling session ticket')
        const response = await this.device.restClient.request({
            method: 'POST',
            url: 'https://app.ring.com/api/v1/clap/ticket/request/signalsocket'
        })
        ticket = response?.ticket
    } catch (error) {
        if (generation !== this.liveRequestGeneration) return
        this.debug(error)
    }

    // Live Allow may have been turned OFF while the Ring ticket request was in flight.
    if (generation !== this.liveRequestGeneration || this.data.live_allow.state !== 'ON' || this.kiBurstController.running) {
        this.debug('Discarding stale live ticket because the live request was cancelled/replaced')
        return
    }

    if (!ticket) {
        this.data.stream.live.status = 'failed'
        this.data.stream.live.session = false
        this.activeLiveRequestId = null
        this.publishStreamState()
        return
    }

    this.data.stream.live.worker.postMessage({
        command: 'start',
        requestId,
        streamData: { rtspPublishUrl, ticket }
    })
}

Camera.prototype.setLiveStreamState = function(message) {
    ensureBuild12(this)
    const command = String(message).toLowerCase()
    this.debug(`Received set live stream state ${message}`)

    if (command.startsWith('on-demand')) {
        if (this.data.live_allow.state !== 'ON') {
            this.data.stream.live.pendingOnDemandUrl = null
            this.data.stream.live.pendingOnDemandAt = 0
            this.debug('Blocking ON-DEMAND because Live Allow is OFF')
            return
        }
        if (this.kiBurstController.running) {
            this.debug('Blocking ON-DEMAND while KI Burst owns the WebRTC session')
            return
        }
        if (this.data.stream.live.status === 'active' || this.data.stream.live.status === 'activating') {
            this.publishStreamState()
            this.rescheduleAutoOff()
            return
        }

        const rtspPublishUrl = String(message).split(' ')[1]
        if (!rtspPublishUrl) {
            this.debug('ON-DEMAND command did not include an RTSP publish URL')
            return
        }

        this.data.stream.live.status = 'activating'
        this.data.stream.live.session = false
        this.publishStreamState()
        this.startLiveStream(rtspPublishUrl)
        return
    }

    if (command === 'on') {
        this.debug('Ignoring manual live stream ON command (status entity; use Live Allow)')
        return
    }

    if (command === 'off') {
        invalidateLiveRequest(this)
        this.data.stream.live.worker.postMessage({ command: 'stop', reason: 'on-demand-off' })
        this.data.stream.live.status = 'inactive'
        this.data.stream.live.session = false
        clearAutoOff(this)
        this.publishStreamState(true, 'live')
        return
    }

    this.debug('Received unknown command for live stream')
}

Camera.prototype.startKeepaliveStream = function() {
    ensureBuild12(this)
    const keepalive = this.data.stream.keepalive
    if (this.data.live_allow.state !== 'ON' || this.kiBurstController.running || keepalive.session || keepalive.active) return

    const generation = (keepalive.generation || 0) + 1
    keepalive.generation = generation
    const rtspPublishUrl = (utils.config().livestream_user && utils.config().livestream_pass)
        ? `rtsp://${utils.config().livestream_user}:${utils.config().livestream_pass}@localhost:8554/${this.deviceId}_live`
        : `rtsp://localhost:8554/${this.deviceId}_live`

    this.debug('Starting build-12 keepalive stream')
    const session = spawn(pathToFfmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', rtspPublishUrl,
        '-map', '0:a:0',
        '-c:a', 'copy',
        '-f', 'null',
        '/dev/null'
    ])
    keepalive.session = session
    keepalive.active = true
    keepalive.expires = Math.floor(Date.now() / 1000) + 86400

    session.on('error', error => {
        if (keepalive.generation !== generation || keepalive.session !== session) return
        this.debug(`Keepalive ffmpeg error: ${error?.message || error}`)
        keepalive.session = false
        keepalive.active = false
    })
    session.on('close', () => {
        if (keepalive.generation !== generation || keepalive.session !== session) return
        keepalive.session = false
        keepalive.active = false
        this.debug('Build-12 keepalive stream stopped')
    })

    keepalive.timer = setTimeout(() => {
        if (keepalive.generation === generation && keepalive.session === session) stopKeepalive(this)
    }, 86400 * 1000)
}

Camera.prototype.setLiveAllowState = function(message) {
    ensureBuild12(this)
    const command = String(message).toLowerCase()
    if (command !== 'on' && command !== 'off') return

    const newState = command === 'on' ? 'ON' : 'OFF'
    this.debug(`Received set live_allow state ${message}`)
    this.data.live_allow.state = newState
    this.data.stream.live.pendingOnDemandUrl = null
    this.data.stream.live.pendingOnDemandAt = 0
    this.publishLiveAllowState()
    this.updateDeviceState()

    if (newState === 'ON') {
        // Only a fresh go2rtc ON-DEMAND request may start a live session. Never reuse stale pending URLs.
        if (!this.kiBurstController.running) this.startKeepaliveStream()
        this.rescheduleAutoOff()
        return
    }

    this.debug('Live Allow OFF -> hard stop of keepalive and WebRTC worker')
    invalidateLiveRequest(this)
    stopKeepalive(this)
    clearAutoOff(this)
    this.data.stream.live.worker.postMessage({ command: 'stop', reason: 'live-allow-off' })
    this.data.stream.live.status = 'inactive'
    this.data.stream.live.session = false
    this.data.stream.live.publishedStatus = ''
    this.publishStreamState(true, 'live')
}

Camera.prototype.rescheduleAutoOff = function() {
    ensureBuild12(this)
    clearAutoOff(this)
    if (!this.data.auto_off.enabled) return
    if (this.data.live_allow.state !== 'ON') return
    if (this.data.stream.live.status !== 'active' && this.data.stream.live.status !== 'activating') return

    const generation = this.liveRequestGeneration
    const ms = this.data.auto_off.minutes * 60 * 1000
    this.debug(`Scheduling build-12 auto-off in ${this.data.auto_off.minutes} minutes`)
    this.data.auto_off.timer = setTimeout(() => {
        if (generation !== this.liveRequestGeneration || this.data.live_allow.state !== 'ON') return
        this.debug('Auto-off fired -> disabling Live Allow and stopping all live resources')
        this.setLiveAllowState('OFF')
    }, ms)
}

Camera.prototype.takeKiBurst = async function() {
    ensureBuild12(this)
    if (this.kiBurstController.running) {
        this.debug('Ignoring KI Burst request because a burst is already running')
        return false
    }

    // KI Burst owns a short dedicated Ring call. It never uses snapshot API or go2rtc/keepalive.
    invalidateLiveRequest(this)
    stopKeepalive(this)
    clearAutoOff(this)
    this.data.stream.live.worker.postMessage({ command: 'stop', reason: 'ki-burst-preflight' })
    this.data.stream.live.status = 'inactive'
    this.data.stream.live.session = false
    this.publishStreamState(true, 'live')

    const burstId = await this.kiBurstController.start({
        frameCount: KI_BURST_FRAME_COUNT,
        intervalMs: KI_BURST_INTERVAL_MS,
        observationWindowMs: KI_BURST_OBSERVATION_WINDOW_MS,
        workerTimeoutMs: KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS,
        outputDir: process.env.KI_BURST_DIR || '/data/ki-burst'
    })
    return Boolean(burstId)
}
