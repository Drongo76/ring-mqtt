import {
    KiBurstController,
    KI_BURST_FRAME_COUNT,
    KI_BURST_INTERVAL_MS,
    KI_BURST_OBSERVATION_WINDOW_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from './ki-burst-controller.js'
import { publishBurstState, publishWarmState, republishBurstState } from './ki-burst-publisher.js'

export const KI_BURST_PRE_ROLL_MS = 3000

// KI Burst as a camera feature: Home Assistant entities, command handling, the burst controller and
// the public state. The Ring camera class owns one instance and forwards the relevant events to it.
// The live-stream side is reached only through the `liveControl` it is given, so the two never
// share mutable state.
export default class KiBurstFeature {
    constructor(camera, {
        liveControl,
        outputDir = process.env.KI_BURST_DIR || '/data/ki-burst',
        createController = options => new KiBurstController(options),
        savedState = camera.getSavedState?.() || {}
    } = {}) {
        this.camera = camera
        this.liveControl = liveControl
        this.outputDir = outputDir
        this.createController = createController
        this.controller = null
        this.worker = null
        // The worker reports whether a warm source is ready right now; the switch only says it is wanted.
        this.warmReady = false
        this.warmStatus = { enabled: false, state: 'stopped' }
        camera.data.ki_burst_warm = {
            state: savedState?.ki_burst_warm?.state === 'ON' ? 'ON' : 'OFF',
            publishedState: null
        }

        camera.data.ki_burst = {
            status: 'idle',
            burstId: null,
            motionEventTimestamp: null,
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
        camera.entity.ki_burst_warm = {
            component: 'switch',
            category: 'config',
            name: 'KI Burst Warm',
            icon: 'mdi:camera-timer'
        }
        camera.entity.ki_burst_status = {
            component: 'sensor',
            name: 'KI Burst Status',
            icon: 'mdi:image-multiple',
            attributes: true
        }
    }

    get running() {
        return Boolean(this.controller?.running)
    }

    // Binds the feature to the live worker. The worker carries both live streaming and burst sessions.
    attachWorker(worker) {
        this.worker = worker
        this.controller = this.createController({
            onFallback: (burstId, reason) => {
                this.camera.debug(`KI Burst ${burstId} warm source unusable (${reason}); falling back to a dedicated session`, 'wrtc')
                this.liveControl.yieldToBurst()
            },
            requestTicket: async () => {
                const ticket = await this.liveControl.requestTicket()
                if (!ticket) throw new Error('Ring did not return a WebRTC signaling ticket')
                return ticket
            },
            sendWorker: message => worker.postMessage(message),
            onState: (status, details) => publishBurstState(this.camera, status, details)
        })
        if (this.camera.data.ki_burst_warm.state === 'ON') this.startWarm()
    }

    persistedState() {
        return { state: this.camera.data.ki_burst_warm.state }
    }

    startWarm() {
        this.worker?.postMessage({ command: 'warm_start' })
    }

    stopWarm() {
        this.worker?.postMessage({ command: 'warm_stop' })
        this.warmReady = false
    }

    setWarmState(message) {
        const command = String(message).toLowerCase()
        if (command !== 'on' && command !== 'off') {
            this.camera.debug(`Received invalid KI Burst Warm command: ${message}`)
            return
        }
        const state = command === 'on' ? 'ON' : 'OFF'
        this.camera.debug(`Received set KI Burst Warm ${state}`)
        this.camera.data.ki_burst_warm.state = state
        if (state === 'ON') this.startWarm()
        else this.stopWarm()
        this.publishWarmSwitch()
        this.camera.updateDeviceState()
    }

    publishWarmSwitch(force = false) {
        const entity = this.camera.entity.ki_burst_warm
        const warm = this.camera.data.ki_burst_warm
        if (!entity?.state_topic) return
        if (force || warm.publishedState !== warm.state) {
            warm.publishedState = warm.state
            this.camera.mqttPublish(entity.state_topic, warm.state, true)
        }
    }

    // Returns true when the message belonged to a burst.
    handleWorkerMessage(message) {
        if (message?.type === 'warm_state') {
            this.warmReady = Boolean(message.ready)
            this.warmStatus = message.status || { enabled: false, state: 'stopped' }
            publishWarmState(this.camera, this.warmStatus, this.warmReady)
            return true
        }
        if (message?.type === 'warm_ticket_request') {
            this.answerWarmTicket(message.requestId)
            return true
        }
        return this.controller ? this.controller.handleWorkerMessage(message) : false
    }

    async answerWarmTicket(requestId) {
        try {
            const ticket = await this.liveControl.requestTicket()
            this.worker.postMessage({ command: 'warm_ticket', requestId, ticket })
        } catch (error) {
            this.worker.postMessage({ command: 'warm_ticket', requestId, error: error?.message || String(error) })
        }
    }

    handleWorkerCrash() {
        this.controller?.cancel('Live worker crashed')
    }

    republish() {
        this.publishWarmSwitch(true)
        republishBurstState(this.camera)
    }

    handleWarmCommand(message) {
        this.setWarmState(message)
    }

    handleCommand(message) {
        if (String(message).toLowerCase() === 'press') {
            this.take()
        } else {
            this.camera.debug(`Received invalid KI Burst command: ${message}`)
        }
    }

    async take() {
        const camera = this.camera
        if (this.running) {
            camera.debug('Ignoring KI Burst request because a burst is already running')
            return false
        }

        const currentMotionTimestamp = camera.data.motion?.active_ding ? Number(camera.data.motion.last_ding) : NaN
        camera.data.ki_burst.motionEventTimestamp = Number.isFinite(currentMotionTimestamp) && currentMotionTimestamp > 0
            ? currentMotionTimestamp
            : null

        // From a warm source the video already exists and nothing live is disturbed. Otherwise the burst
        // owns a short dedicated Ring call and the live worker must step aside first.
        // Frame 1 is the ordinary Motion Snapshot, picked up at final publication.
        const source = this.warmReady ? 'warm' : 'cold'
        if (source === 'cold') this.liveControl.yieldToBurst()

        const burstId = await this.controller.start({
            frameCount: KI_BURST_FRAME_COUNT,
            intervalMs: KI_BURST_INTERVAL_MS,
            observationWindowMs: KI_BURST_OBSERVATION_WINDOW_MS,
            workerTimeoutMs: KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS,
            outputDir: this.outputDir,
            source,
            preRollMs: KI_BURST_PRE_ROLL_MS
        })
        return Boolean(burstId)
    }
}
