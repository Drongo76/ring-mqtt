const DEFAULT_FRAME_COUNT = 3
const DEFAULT_INTERVAL_MS = 450
const DEFAULT_TIMEOUT_MS = 12000

function asBuffer(frame) {
    if (Buffer.isBuffer(frame)) return frame
    if (frame instanceof Uint8Array) return Buffer.from(frame)
    throw new TypeError('KI Burst frame is not binary data')
}

export function normalizeBurstFrames(frames, expectedCount = DEFAULT_FRAME_COUNT) {
    if (!Array.isArray(frames) || frames.length !== expectedCount) {
        throw new Error(`KI Burst expected exactly ${expectedCount} frames, received ${Array.isArray(frames) ? frames.length : 0}`)
    }
    return frames.map((frame, index) => {
        const buffer = asBuffer(frame)
        if (buffer.length === 0) throw new Error(`KI Burst frame ${index + 1} is empty`)
        return buffer
    })
}

export class KiBurstController {
    constructor({ requestTicket, sendWorker, onState, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        this.requestTicket = requestTicket
        this.sendWorker = sendWorker
        this.onState = onState
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.timeoutMs = timeoutMs
        this.sequence = 0
        this.activeBurstId = null
        this.timer = null
    }

    get running() {
        return Boolean(this.activeBurstId)
    }

    async start({ frameCount = DEFAULT_FRAME_COUNT, intervalMs = DEFAULT_INTERVAL_MS, workerTimeoutMs = 8000, outputDir = '/data/ki-burst' } = {}) {
        if (this.running) return null
        if (frameCount !== DEFAULT_FRAME_COUNT) throw new Error(`KI Burst frame count is fixed at ${DEFAULT_FRAME_COUNT}`)

        const burstId = `${Date.now()}-${++this.sequence}`
        this.activeBurstId = burstId
        this.onState('capturing', { burstId, frameCount, intervalMs, selectionMode: 'adaptive' })

        this.sendWorker({ command: 'stop', reason: 'ki-burst-preflight' })

        let ticket
        try {
            ticket = await this.requestTicket()
        } catch (error) {
            this.fail(burstId, error?.message || String(error), false)
            return null
        }
        if (this.activeBurstId !== burstId) return null

        this.sendWorker({
            command: 'burst',
            burstId,
            streamData: { ticket },
            options: { frameCount, minSeparationMs: intervalMs, timeoutMs: workerTimeoutMs, outputDir }
        })

        this.timer = this.setTimer(() => this.fail(burstId, `KI Burst timed out after ${this.timeoutMs} ms`, true), this.timeoutMs)
        return burstId
    }

    handleWorkerMessage(message) {
        if (!message || message.burstId !== this.activeBurstId) return false

        if (message.type === 'burst_complete') {
            try {
                const frames = normalizeBurstFrames(message.frames)
                this.finishTimer()
                const burstId = this.activeBurstId
                this.activeBurstId = null
                this.onState('complete', {
                    burstId,
                    frames,
                    paths: Array.isArray(message.paths) ? message.paths : [],
                    capturedAt: message.capturedAt || new Date().toISOString(),
                    selectionMode: message.selectionMode || 'adaptive',
                    candidateFramesEvaluated: Number.isInteger(message.candidateFramesEvaluated) ? message.candidateFramesEvaluated : 0,
                    frameOffsetsMs: Array.isArray(message.actualFrameOffsetsMs) ? message.actualFrameOffsetsMs : (Array.isArray(message.frameOffsetsMs) ? message.frameOffsetsMs : []),
                    actualFrameOffsetsMs: Array.isArray(message.actualFrameOffsetsMs) ? message.actualFrameOffsetsMs : (Array.isArray(message.frameOffsetsMs) ? message.frameOffsetsMs : []),
                    differenceScores: Array.isArray(message.differenceScores) ? message.differenceScores : [],
                    changedBlockRatios: Array.isArray(message.changedBlockRatios) ? message.changedBlockRatios : [],
                    selectionReasons: Array.isArray(message.selectionReasons) ? message.selectionReasons : [],
                    selectionThreshold: Number.isFinite(message.selectionThreshold) ? message.selectionThreshold : null,
                    minimumSelectionSeparationMs: Number.isFinite(message.minimumSelectionSeparationMs) ? message.minimumSelectionSeparationMs : DEFAULT_INTERVAL_MS,
                    framePts: Array.isArray(message.framePts) ? message.framePts : [],
                    framePtsTime: Array.isArray(message.framePtsTime) ? message.framePtsTime : [],
                    frameTimestamps: Array.isArray(message.frameTimestamps) ? message.frameTimestamps : [],
                    frameTypes: Array.isArray(message.frameTypes) ? message.frameTypes : [],
                    frameRawChecksums: Array.isArray(message.frameRawChecksums) ? message.frameRawChecksums : [],
                    frameHashes: Array.isArray(message.frameHashes) ? message.frameHashes : [],
                    rtpIntegrity: message.rtpIntegrity && typeof message.rtpIntegrity === 'object' ? message.rtpIntegrity : {},
                    frameCount: frames.length,
                    intervalMs: Number.isFinite(message.minimumSelectionSeparationMs) ? message.minimumSelectionSeparationMs : DEFAULT_INTERVAL_MS
                })
            } catch (error) {
                this.fail(message.burstId, error.message, true)
            }
            return true
        }

        if (message.type === 'burst_failed') {
            this.fail(message.burstId, message.error || 'Unknown KI Burst worker failure', false)
            return true
        }

        return false
    }

    cancel(reason = 'KI Burst cancelled') {
        if (!this.activeBurstId) return
        this.fail(this.activeBurstId, reason, true)
    }

    fail(burstId, error, stopWorker) {
        if (burstId !== this.activeBurstId) return
        this.finishTimer()
        this.activeBurstId = null
        if (stopWorker) this.sendWorker({ command: 'stop', reason: 'ki-burst-failed' })
        this.onState('failed', { burstId, error })
    }

    finishTimer() {
        if (this.timer) {
            this.clearTimer(this.timer)
            this.timer = null
        }
    }
}

export const KI_BURST_FRAME_COUNT = DEFAULT_FRAME_COUNT
// Compatibility name used by the build-12 HA patch; now represents only the adaptive selector's minimum separation.
export const KI_BURST_INTERVAL_MS = DEFAULT_INTERVAL_MS
