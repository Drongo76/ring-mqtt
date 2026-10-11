import {
    KiBurstController,
    KI_BURST_FRAME_COUNT,
    KI_BURST_INTERVAL_MS,
    KI_BURST_OBSERVATION_WINDOW_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from './ki-burst-controller.js'
import { publishBurstState, republishBurstState } from './ki-burst-publisher.js'

// KI Burst as a camera feature: Home Assistant entities, command handling, the burst controller and
// the public state. The Ring camera class owns one instance and forwards the relevant events to it.
// The live-stream side is reached only through the `liveControl` it is given, so the two never
// share mutable state.
export default class KiBurstFeature {
    constructor(camera, { liveControl, outputDir = process.env.KI_BURST_DIR || '/data/ki-burst', createController = options => new KiBurstController(options) } = {}) {
        this.camera = camera
        this.liveControl = liveControl
        this.outputDir = outputDir
        this.createController = createController
        this.controller = null

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
        this.controller = this.createController({
            requestTicket: async () => {
                const ticket = await this.liveControl.requestTicket()
                if (!ticket) throw new Error('Ring did not return a WebRTC signaling ticket')
                return ticket
            },
            sendWorker: message => worker.postMessage(message),
            onState: (status, details) => publishBurstState(this.camera, status, details)
        })
    }

    // Returns true when the message belonged to a burst.
    handleWorkerMessage(message) {
        return this.controller ? this.controller.handleWorkerMessage(message) : false
    }

    handleWorkerCrash() {
        this.controller?.cancel('Live worker crashed')
    }

    republish() {
        republishBurstState(this.camera)
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

        // A burst owns a short dedicated Ring call and never uses the snapshot API or go2rtc/keepalive.
        // Frame 1 is the ordinary Motion Snapshot, picked up at final publication.
        this.liveControl.yieldToBurst()

        const burstId = await this.controller.start({
            frameCount: KI_BURST_FRAME_COUNT,
            intervalMs: KI_BURST_INTERVAL_MS,
            observationWindowMs: KI_BURST_OBSERVATION_WINDOW_MS,
            workerTimeoutMs: KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS,
            outputDir: this.outputDir
        })
        return Boolean(burstId)
    }
}
