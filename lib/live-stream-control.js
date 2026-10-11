import { Worker } from 'worker_threads'
import { spawn } from 'child_process'

const KEEPALIVE_DURATION_MS = 86400 * 1000

// Owns the live-stream side of a camera: the WebRTC live worker, the keepalive reader that
// triggers go2rtc ON-DEMAND, the Live Allow kill switch and the auto-off timer.
//
// It talks to the camera only through its public members (data, debug, publish* methods,
// device.restClient), and everything with a side effect on the outside world
// (worker, process spawning, configuration, ffmpeg path) is injectable so the state machine
// can be tested without Ring, MQTT or ffmpeg.
export default class LiveStreamControl {
    constructor(camera, {
        createWorker = () => new Worker(new URL('../devices/camera-livestream-build12.js', import.meta.url), {
            workerData: { doorbotId: camera.device.id, deviceName: camera.deviceData.name }
        }),
        spawnProcess = spawn,
        ffmpegPath,
        getConfig = () => ({}),
        interceptWorkerMessage = () => false,
        isBurstRunning = () => false,
        onWorkerCrash = () => {},
        now = Date.now
    } = {}) {
        this.camera = camera
        this.createWorker = createWorker
        this.spawnProcess = spawnProcess
        this.ffmpegPath = ffmpegPath
        this.getConfig = getConfig
        this.interceptWorkerMessage = interceptWorkerMessage
        this.isBurstRunning = isBurstRunning
        this.onWorkerCrash = onWorkerCrash
        this.now = now

        this.requestGeneration = 0
        this.activeRequestId = null
        this.worker = null
    }

    get live() { return this.camera.data.stream.live }
    get keepalive() { return this.camera.data.stream.keepalive }

    // Creates the live worker and wires its messages. Messages the interceptor claims
    // (KI Burst) never reach the live state machine.
    attachWorker() {
        this.disposeWorker(this.worker, 'worker-replace')
        const worker = this.createWorker()
        this.worker = worker
        this.live.worker = worker

        worker.on('message', message => {
            if (this.interceptWorkerMessage(message)) return
            this.handleWorkerMessage(message)
        })
        worker.on('error', error => this.handleWorkerError(error))
        return worker
    }

    disposeWorker(worker, reason) {
        if (!worker) return
        try {
            worker.removeAllListeners?.('message')
            worker.postMessage?.({ command: 'stop', reason })
            worker.terminate?.().catch?.(() => {})
        } catch {}
    }

    handleWorkerMessage(message) {
        const camera = this.camera
        if (message.type === 'state' && message.kind === 'live') {
            // A callback from an older worker session can never change the current session state.
            if (message.requestId !== this.activeRequestId) return

            if (message.data === 'active') {
                this.live.status = 'active'
                this.live.session = true
                this.rescheduleAutoOff()
            } else if (message.data === 'inactive' || message.data === 'failed') {
                this.live.status = message.data
                this.live.session = false
                this.activeRequestId = null
                this.clearAutoOff()
            }
            camera.publishStreamState()
            return
        }

        if (message.type === 'log_info' || message.type === 'log_error') camera.debug(message.data, 'wrtc')
    }

    handleWorkerError(error) {
        const camera = this.camera
        camera.debug(`Live worker error: ${error?.stack || error?.message || error}`, 'wrtc')
        if (this.activeRequestId !== null) {
            this.live.status = 'failed'
            this.live.session = false
            this.activeRequestId = null
            camera.publishStreamState()
        }
        this.onWorkerCrash(error)
    }

    clearAutoOff() {
        const autoOff = this.camera.data?.auto_off
        if (autoOff?.timer) {
            clearTimeout(autoOff.timer)
            autoOff.timer = null
        }
    }

    // Any in-flight ticket request or stale worker callback of an earlier request is ignored afterwards.
    invalidateRequest() {
        this.requestGeneration++
        this.activeRequestId = null
        this.live.pendingOnDemandUrl = null
        this.live.pendingOnDemandAt = 0
    }

    stopKeepalive() {
        const keepalive = this.keepalive
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

    // Stops everything live-related and reports it as inactive.
    stopAll(reason) {
        this.invalidateRequest()
        this.stopKeepalive()
        this.clearAutoOff()
        this.worker?.postMessage({ command: 'stop', reason })
        this.live.status = 'inactive'
        this.live.session = false
        this.live.publishedStatus = ''
        this.camera.publishStreamState(true, 'live')
    }

    async requestTicket() {
        const response = await this.camera.device.restClient.request({
            method: 'POST',
            url: 'https://app.ring.com/api/v1/clap/ticket/request/signalsocket'
        })
        return response?.ticket
    }

    async startLiveStream(rtspPublishUrl) {
        const camera = this.camera
        if (camera.data.live_allow.state !== 'ON' || this.isBurstRunning()) return

        const requestId = ++this.requestGeneration
        this.activeRequestId = requestId

        let ticket
        try {
            camera.debug('Acquiring a live stream WebRTC signaling session ticket')
            ticket = await this.requestTicket()
        } catch (error) {
            if (requestId !== this.requestGeneration) return
            if (error?.response?.statusCode === 403) {
                camera.debug('Camera returned 403 when starting a live stream. This usually indicates that live streaming is blocked by Modes settings. Check your Ring app and verify that you are able to stream from this camera with the current Modes settings.')
            } else {
                camera.debug(error)
            }
        }

        // Live Allow may have been turned OFF while the Ring ticket request was in flight.
        if (requestId !== this.requestGeneration || camera.data.live_allow.state !== 'ON' || this.isBurstRunning()) {
            camera.debug('Discarding stale live ticket because the live request was cancelled/replaced')
            return
        }

        if (!ticket) {
            camera.debug('Live stream failed to initialize WebRTC signaling session')
            this.live.status = 'failed'
            this.live.session = false
            this.activeRequestId = null
            camera.publishStreamState()
            return
        }

        this.worker.postMessage({ command: 'start', requestId, streamData: { rtspPublishUrl, ticket } })
    }

    setLiveStreamState(message) {
        const camera = this.camera
        const command = String(message).toLowerCase()
        camera.debug(`Received set live stream state ${message}`)

        if (command.startsWith('on-demand')) {
            if (camera.data.live_allow.state !== 'ON') {
                this.live.pendingOnDemandUrl = null
                this.live.pendingOnDemandAt = 0
                camera.debug('Blocking ON-DEMAND because Live Allow is OFF')
                return
            }
            if (this.isBurstRunning()) {
                camera.debug('Blocking ON-DEMAND while KI Burst owns the WebRTC session')
                return
            }
            if (this.live.status === 'active' || this.live.status === 'activating') {
                camera.publishStreamState()
                this.rescheduleAutoOff()
                return
            }

            const rtspPublishUrl = String(message).split(' ')[1]
            if (!rtspPublishUrl) {
                camera.debug('ON-DEMAND command did not include an RTSP publish URL')
                return
            }

            this.live.status = 'activating'
            this.live.session = false
            camera.publishStreamState()
            this.startLiveStream(rtspPublishUrl)
            return
        }

        if (command === 'on') {
            camera.debug('Ignoring manual live stream ON command (status entity; use Live Allow)')
            return
        }

        if (command === 'off') {
            this.invalidateRequest()
            this.worker.postMessage({ command: 'stop', reason: 'on-demand-off' })
            this.live.status = 'inactive'
            this.live.session = false
            this.clearAutoOff()
            camera.publishStreamState(true, 'live')
            return
        }

        camera.debug('Received unknown command for live stream')
    }

    startKeepaliveStream() {
        const camera = this.camera
        const keepalive = this.keepalive
        if (camera.data.live_allow.state !== 'ON' || this.isBurstRunning() || keepalive.session || keepalive.active) return

        const generation = (keepalive.generation || 0) + 1
        keepalive.generation = generation
        const config = this.getConfig()
        const rtspPublishUrl = (config.livestream_user && config.livestream_pass)
            ? `rtsp://${config.livestream_user}:${config.livestream_pass}@localhost:8554/${camera.deviceId}_live`
            : `rtsp://localhost:8554/${camera.deviceId}_live`

        camera.debug('Starting keepalive stream')
        // The keepalive reads only the audio stream to a null output. That is enough to make the RTSP
        // server start the on-demand stream and keep it running when there are no other readers.
        const session = this.spawnProcess(this.ffmpegPath, [
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
        keepalive.expires = Math.floor(this.now() / 1000) + 86400

        session.on('error', error => {
            if (keepalive.generation !== generation || keepalive.session !== session) return
            camera.debug(`Keepalive ffmpeg error: ${error?.message || error}`)
            keepalive.session = false
            keepalive.active = false
        })
        session.on('close', () => {
            if (keepalive.generation !== generation || keepalive.session !== session) return
            keepalive.session = false
            keepalive.active = false
            camera.debug('Keepalive stream stopped')
        })

        keepalive.timer = setTimeout(() => {
            if (keepalive.generation === generation && keepalive.session === session) this.stopKeepalive()
        }, KEEPALIVE_DURATION_MS)
    }

    setLiveAllowState(message) {
        const camera = this.camera
        const command = String(message).toLowerCase()
        if (command !== 'on' && command !== 'off') return

        const newState = command === 'on' ? 'ON' : 'OFF'
        camera.debug(`Received set live_allow state ${message}`)
        camera.data.live_allow.state = newState
        this.live.pendingOnDemandUrl = null
        this.live.pendingOnDemandAt = 0
        camera.publishLiveAllowState()
        camera.updateDeviceState()

        if (newState === 'ON') {
            // Only a fresh go2rtc ON-DEMAND request may start a live session. Stale pending URLs are never reused.
            if (!this.isBurstRunning()) this.startKeepaliveStream()
            this.rescheduleAutoOff()
            return
        }

        camera.debug('Live Allow OFF -> hard stop of keepalive and WebRTC worker')
        this.stopAll('live-allow-off')
    }

    rescheduleAutoOff() {
        const camera = this.camera
        this.clearAutoOff()
        const autoOff = camera.data.auto_off
        if (!autoOff.enabled) return
        if (camera.data.live_allow.state !== 'ON') return
        if (this.live.status !== 'active' && this.live.status !== 'activating') return

        const generation = this.requestGeneration
        camera.debug(`Scheduling auto-off in ${autoOff.minutes} minutes`)
        autoOff.timer = setTimeout(() => {
            if (generation !== this.requestGeneration || camera.data.live_allow.state !== 'ON') return
            camera.debug('Auto-off fired -> disabling Live Allow and stopping all live resources')
            this.setLiveAllowState('OFF')
        }, autoOff.minutes * 60 * 1000)
    }

    // Used by KI Burst: it needs the WebRTC slot to itself for a few seconds.
    yieldToBurst() {
        this.invalidateRequest()
        this.stopKeepalive()
        this.clearAutoOff()
        this.worker.postMessage({ command: 'stop', reason: 'ki-burst-preflight' })
        this.live.status = 'inactive'
        this.live.session = false
        this.camera.publishStreamState(true, 'live')
    }
}
