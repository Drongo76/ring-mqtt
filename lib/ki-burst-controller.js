const DEFAULT_FRAME_COUNT = 3
const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_OBSERVATION_WINDOW_MS = 6000
const DEFAULT_WORKER_HARD_SAFETY_TIMEOUT_MS = 25000
const DEFAULT_CONTROLLER_FINALIZATION_GRACE_MS = 5000
const DEFAULT_TIMEOUT_MS = DEFAULT_WORKER_HARD_SAFETY_TIMEOUT_MS + DEFAULT_OBSERVATION_WINDOW_MS + DEFAULT_CONTROLLER_FINALIZATION_GRACE_MS

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
    constructor({ requestTicket, sendWorker, onState, onFallback = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        this.requestTicket = requestTicket
        this.sendWorker = sendWorker
        this.onState = onState
        this.onFallback = onFallback
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.timeoutMs = timeoutMs
        this.sequence = 0
        this.activeBurstId = null
        this.activeParams = null
        this.timer = null
    }

    get running() {
        return Boolean(this.activeBurstId)
    }

    async start({
        frameCount = DEFAULT_FRAME_COUNT,
        intervalMs = DEFAULT_INTERVAL_MS,
        workerTimeoutMs = DEFAULT_WORKER_HARD_SAFETY_TIMEOUT_MS,
        observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS,
        outputDir = '/data/ki-burst',
        source = 'cold',
        preRollMs
    } = {}) {
        if (this.running) return null
        if (frameCount !== DEFAULT_FRAME_COUNT) throw new Error(`KI Burst frame count is fixed at ${DEFAULT_FRAME_COUNT}`)

        const burstId = `${Date.now()}-${++this.sequence}`
        this.activeBurstId = burstId
        this.onState('capturing', {
            burstId,
            frameCount,
            intervalMs,
            selectionMode: 'adaptive_buffered',
            observationWindowMs
        })

        this.activeParams = {
            frameCount,
            minSeparationMs: intervalMs,
            observationWindowMs,
            hardSafetyTimeoutMs: workerTimeoutMs,
            outputDir
        }

        if (source === 'warm') {
            // The warm session already exists in the worker: no preflight stop and no ticket round trip.
            this.sendWorker({
                command: 'burst',
                burstId,
                source: 'warm',
                options: { ...this.activeParams, ...(preRollMs !== undefined ? { preRollMs } : {}) }
            })
        } else if (!await this.startCold(burstId)) {
            return null
        }

        this.timer = this.setTimer(() => this.fail(burstId, `KI Burst timed out after ${this.timeoutMs} ms`, true), this.timeoutMs)
        return burstId
    }

    // Dedicated cold session: needs the live worker out of the way and a fresh signaling ticket.
    async startCold(burstId) {
        this.sendWorker({ command: 'stop', reason: 'ki-burst-preflight' })

        let ticket
        try {
            ticket = await this.requestTicket()
        } catch (error) {
            this.fail(burstId, error?.message || String(error), false)
            return false
        }
        if (this.activeBurstId !== burstId) return false

        this.sendWorker({
            command: 'burst',
            burstId,
            streamData: { ticket },
            options: this.activeParams
        })
        return true
    }

    handleWorkerMessage(message) {
        if (!message || message.burstId !== this.activeBurstId) return false

        if (message.type === 'burst_complete') {
            try {
                const frames = normalizeBurstFrames(message.frames)
                this.finishTimer()
                const burstId = this.activeBurstId
                this.activeBurstId = null
                this.activeParams = null
                this.onState('complete', {
                    burstId,
                    frames,
                    paths: Array.isArray(message.paths) ? message.paths : [],
                    capturedAt: message.capturedAt || new Date().toISOString(),
                    selectionMode: message.selectionMode || 'adaptive_buffered',
                    observationWindowMs: Number.isFinite(message.observationWindowMs) ? message.observationWindowMs : DEFAULT_OBSERVATION_WINDOW_MS,
                    candidateFramesEvaluated: Number.isInteger(message.candidateFramesEvaluated) ? message.candidateFramesEvaluated : 0,
                    frameOffsetsMs: Array.isArray(message.actualFrameOffsetsMs) ? message.actualFrameOffsetsMs : (Array.isArray(message.frameOffsetsMs) ? message.frameOffsetsMs : []),
                    actualFrameOffsetsMs: Array.isArray(message.actualFrameOffsetsMs) ? message.actualFrameOffsetsMs : (Array.isArray(message.frameOffsetsMs) ? message.frameOffsetsMs : []),
                    targetFrameOffsetsMs: [],
                    differenceScores: Array.isArray(message.differenceScores) ? message.differenceScores : [],
                    changedBlockRatios: Array.isArray(message.changedBlockRatios) ? message.changedBlockRatios : [],
                    pairwiseDifferenceScores: Array.isArray(message.pairwiseDifferenceScores) ? message.pairwiseDifferenceScores : [],
                    totalDiversityScore: Number.isFinite(message.totalDiversityScore) ? message.totalDiversityScore : null,
                    selectionReasons: Array.isArray(message.selectionReasons) ? message.selectionReasons : [],
                    selectionThreshold: Number.isFinite(message.selectionThreshold) ? message.selectionThreshold : null,
                    minimumSelectionSeparationMs: Number.isFinite(message.minimumSelectionSeparationMs) ? message.minimumSelectionSeparationMs : DEFAULT_INTERVAL_MS,
                    firstCleanFrameAt: message.firstCleanFrameAt || null,
                    totalBurstDurationMs: Number.isFinite(message.totalBurstDurationMs) ? message.totalBurstDurationMs : null,
                    frameSourceIndices: Array.isArray(message.frameSourceIndices) ? message.frameSourceIndices : [],
                    framePts: Array.isArray(message.framePts) ? message.framePts : [],
                    framePtsTime: Array.isArray(message.framePtsTime) ? message.framePtsTime : [],
                    frameTimestamps: Array.isArray(message.frameTimestamps) ? message.frameTimestamps : [],
                    frameTypes: Array.isArray(message.frameTypes) ? message.frameTypes : [],
                    frameRawChecksums: Array.isArray(message.frameRawChecksums) ? message.frameRawChecksums : [],
                    frameHashes: Array.isArray(message.frameHashes) ? message.frameHashes : [],
                    rtpIntegrity: message.rtpIntegrity && typeof message.rtpIntegrity === 'object' ? message.rtpIntegrity : {},
                    rejectedPtsCandidates: Array.isArray(message.rejectedPtsCandidates) ? message.rejectedPtsCandidates : [],
                    source: message.source === 'warm' ? 'warm' : 'cold',
                    preRollMs: Number.isFinite(message.preRollMs) ? message.preRollMs : null,
                    replayedUnits: Number.isInteger(message.replayedUnits) ? message.replayedUnits : null,
                    frameCount: frames.length,
                    intervalMs: Number.isFinite(message.minimumSelectionSeparationMs) ? message.minimumSelectionSeparationMs : DEFAULT_INTERVAL_MS
                })
            } catch (error) {
                this.fail(message.burstId, error.message, true)
            }
            return true
        }

        if (message.type === 'burst_failed') {
            if (message.fallback === 'cold' && this.activeParams) {
                // The warm source was not usable. Run the same burst on a dedicated session instead.
                const burstId = this.activeBurstId
                this.onFallback(burstId, message.error || 'warm source unavailable')
                this.startCold(burstId)
                return true
            }
            const diagnostics = message.diagnostics && typeof message.diagnostics === 'object' ? message.diagnostics : {}
            this.fail(message.burstId, message.error || 'Unknown KI Burst worker failure', false, diagnostics)
            return true
        }

        return false
    }

    cancel(reason = 'KI Burst cancelled') {
        if (!this.activeBurstId) return
        this.fail(this.activeBurstId, reason, true)
    }

    fail(burstId, error, stopWorker, diagnostics = {}) {
        if (burstId !== this.activeBurstId) return
        this.finishTimer()
        this.activeBurstId = null
        this.activeParams = null
        if (stopWorker) this.sendWorker({ command: 'stop', reason: 'ki-burst-failed' })
        this.onState('failed', { burstId, error, ...diagnostics })
    }

    finishTimer() {
        if (this.timer) {
            this.clearTimer(this.timer)
            this.timer = null
        }
    }
}

export const KI_BURST_FRAME_COUNT = DEFAULT_FRAME_COUNT
// Compatibility name used by the build-12 HA patch; it is only the buffered selector's
// minimum temporal separation guard, never a frame-selection schedule.
export const KI_BURST_INTERVAL_MS = DEFAULT_INTERVAL_MS
export const KI_BURST_OBSERVATION_WINDOW_MS = DEFAULT_OBSERVATION_WINDOW_MS
export const KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS = DEFAULT_WORKER_HARD_SAFETY_TIMEOUT_MS
export const KI_BURST_CONTROLLER_FINALIZATION_GRACE_MS = DEFAULT_CONTROLLER_FINALIZATION_GRACE_MS
export const KI_BURST_CONTROLLER_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
