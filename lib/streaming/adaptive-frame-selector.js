export const ADAPTIVE_SELECTION_MODE = 'adaptive'
export const DEFAULT_ANALYSIS_WIDTH = 160
export const DEFAULT_ANALYSIS_HEIGHT = 90
export const DEFAULT_BLOCK_SIZE = 8
export const DEFAULT_PIXEL_NOISE_FLOOR = 4
export const DEFAULT_BLOCK_LUMA_THRESHOLD = 12
export const DEFAULT_CHANGED_BLOCK_THRESHOLD = 0.08
export const DEFAULT_MIN_SELECTION_SEPARATION_MS = 450

function round(value, digits = 4) {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
}

export function calculateBlockLumaDifference(reference, candidate, {
    width = DEFAULT_ANALYSIS_WIDTH,
    height = DEFAULT_ANALYSIS_HEIGHT,
    blockSize = DEFAULT_BLOCK_SIZE,
    pixelNoiseFloor = DEFAULT_PIXEL_NOISE_FLOOR,
    blockLumaThreshold = DEFAULT_BLOCK_LUMA_THRESHOLD
} = {}) {
    const expected = width * height
    if (!reference || !candidate || reference.length !== expected || candidate.length !== expected) {
        throw new Error(`Adaptive KI Burst luma frame must contain exactly ${expected} bytes`)
    }

    let totalBlocks = 0
    let changedBlocks = 0
    let totalBlockDifference = 0

    for (let y = 0; y < height; y += blockSize) {
        const yEnd = Math.min(height, y + blockSize)
        for (let x = 0; x < width; x += blockSize) {
            const xEnd = Math.min(width, x + blockSize)
            let sum = 0
            let pixels = 0
            for (let py = y; py < yEnd; py++) {
                const row = py * width
                for (let px = x; px < xEnd; px++) {
                    const delta = Math.abs(candidate[row + px] - reference[row + px])
                    sum += delta <= pixelNoiseFloor ? 0 : delta
                    pixels++
                }
            }
            const meanDifference = pixels ? sum / pixels : 0
            totalBlockDifference += meanDifference
            totalBlocks++
            if (meanDifference >= blockLumaThreshold) changedBlocks++
        }
    }

    const changedBlockRatio = totalBlocks ? changedBlocks / totalBlocks : 0
    const averageBlockDifference = totalBlocks ? totalBlockDifference / totalBlocks : 0
    return {
        changedBlocks,
        totalBlocks,
        changedBlockRatio: round(changedBlockRatio),
        differenceScore: round(averageBlockDifference / 255),
        averageBlockDifference: round(averageBlockDifference, 2)
    }
}

function visualRank(difference) {
    return difference.changedBlockRatio + difference.differenceScore
}

export class AdaptiveFrameSelector {
    constructor({
        frameCount = 3,
        width = DEFAULT_ANALYSIS_WIDTH,
        height = DEFAULT_ANALYSIS_HEIGHT,
        blockSize = DEFAULT_BLOCK_SIZE,
        pixelNoiseFloor = DEFAULT_PIXEL_NOISE_FLOOR,
        blockLumaThreshold = DEFAULT_BLOCK_LUMA_THRESHOLD,
        changedBlockThreshold = DEFAULT_CHANGED_BLOCK_THRESHOLD,
        minSeparationMs = DEFAULT_MIN_SELECTION_SEPARATION_MS
    } = {}) {
        if (frameCount !== 3) throw new Error('Adaptive KI Burst selector is fixed to exactly 3 frames')
        this.frameCount = frameCount
        this.width = width
        this.height = height
        this.blockSize = blockSize
        this.pixelNoiseFloor = pixelNoiseFloor
        this.blockLumaThreshold = blockLumaThreshold
        this.changedBlockThreshold = changedBlockThreshold
        this.minSeparationMs = minSeparationMs
        this.candidates = []
        this.selected = []
        this.candidateFramesEvaluated = 0
    }

    get complete() {
        return this.selected.length === this.frameCount
    }

    compare(reference, candidate) {
        return calculateBlockLumaDifference(reference.luma, candidate.luma, {
            width: this.width,
            height: this.height,
            blockSize: this.blockSize,
            pixelNoiseFloor: this.pixelNoiseFloor,
            blockLumaThreshold: this.blockLumaThreshold
        })
    }

    evaluate(candidate) {
        if (candidate?.clean === false) return { selected: false, reason: 'not_clean' }
        if (!candidate || !Buffer.isBuffer(candidate.luma)) throw new TypeError('Adaptive KI Burst candidate requires a luma Buffer')
        if (!Number.isFinite(candidate.elapsedMs)) throw new TypeError('Adaptive KI Burst candidate requires elapsedMs')

        const record = { ...candidate, index: this.candidates.length }
        this.candidates.push(record)
        this.candidateFramesEvaluated++

        if (this.selected.length === 0) {
            const selected = { ...record, reason: 'first_clean_frame', differenceScore: 0, changedBlockRatio: 0 }
            this.selected.push(selected)
            return { selected: true, reason: selected.reason, differenceScore: 0, changedBlockRatio: 0, record: selected }
        }

        const previous = this.selected.at(-1)
        const difference = this.compare(previous, record)
        if (this.complete) return { selected: false, reason: 'selection_complete', ...difference, record }
        if ((record.elapsedMs - previous.elapsedMs) < this.minSeparationMs) {
            return { selected: false, reason: 'minimum_separation', ...difference, record }
        }
        if (difference.changedBlockRatio < this.changedBlockThreshold) {
            return { selected: false, reason: 'below_motion_threshold', ...difference, record }
        }

        const selected = { ...record, reason: 'motion_displacement', ...difference }
        this.selected.push(selected)
        return { selected: true, reason: selected.reason, ...difference, record: selected }
    }

    finalizeFallback() {
        if (this.complete) return this.result()
        if (this.candidates.length < this.frameCount) {
            throw new Error(`Adaptive KI Burst needs at least ${this.frameCount} clean decoded candidates, received ${this.candidates.length}`)
        }

        const first = this.candidates[0]
        const last = this.candidates.at(-1)
        let bestSecond = null
        for (let i = 1; i < this.candidates.length - 1; i++) {
            const candidate = this.candidates[i]
            if ((candidate.elapsedMs - first.elapsedMs) < this.minSeparationMs) continue
            if ((last.elapsedMs - candidate.elapsedMs) < this.minSeparationMs) continue
            const difference = this.compare(first, candidate)
            const rank = visualRank(difference)
            const balance = Math.min(candidate.elapsedMs - first.elapsedMs, last.elapsedMs - candidate.elapsedMs)
            if (!bestSecond || rank > bestSecond.rank || (rank === bestSecond.rank && balance > bestSecond.balance)) {
                bestSecond = { candidate, difference, rank, balance }
            }
        }

        if (!bestSecond) {
            throw new Error(`Adaptive KI Burst could not find a fallback second frame separated by at least ${this.minSeparationMs} ms`)
        }

        let bestThird = null
        for (const candidate of this.candidates) {
            if (candidate.index <= bestSecond.candidate.index) continue
            if ((candidate.elapsedMs - bestSecond.candidate.elapsedMs) < this.minSeparationMs) continue
            const difference = this.compare(bestSecond.candidate, candidate)
            const rank = visualRank(difference)
            if (!bestThird || rank > bestThird.rank || (rank === bestThird.rank && candidate.elapsedMs > bestThird.candidate.elapsedMs)) {
                bestThird = { candidate, difference, rank }
            }
        }

        if (!bestThird) {
            throw new Error(`Adaptive KI Burst could not find a fallback third frame separated by at least ${this.minSeparationMs} ms`)
        }

        this.selected = [
            { ...first, reason: 'first_clean_frame', differenceScore: 0, changedBlockRatio: 0 },
            { ...bestSecond.candidate, reason: 'timeout_best_candidate', ...bestSecond.difference },
            { ...bestThird.candidate, reason: 'timeout_best_candidate', ...bestThird.difference }
        ]
        return this.result()
    }

    result() {
        if (!this.complete) throw new Error('Adaptive KI Burst selection is not complete')
        const firstElapsed = this.selected[0].elapsedMs
        return {
            selected: [...this.selected],
            diagnostics: {
                selectionMode: ADAPTIVE_SELECTION_MODE,
                candidateFramesEvaluated: this.candidateFramesEvaluated,
                actualFrameOffsetsMs: this.selected.map(frame => Math.round(frame.elapsedMs - firstElapsed)),
                differenceScores: this.selected.map(frame => frame.differenceScore),
                changedBlockRatios: this.selected.map(frame => frame.changedBlockRatio),
                selectionReasons: this.selected.map(frame => frame.reason),
                selectionThreshold: this.changedBlockThreshold
            }
        }
    }
}
