export const ADAPTIVE_SELECTION_MODE = 'adaptive_buffered'
export const DEFAULT_ANALYSIS_WIDTH = 160
export const DEFAULT_ANALYSIS_HEIGHT = 90
export const DEFAULT_BLOCK_SIZE = 8
export const DEFAULT_PIXEL_NOISE_FLOOR = 4
export const DEFAULT_BLOCK_LUMA_THRESHOLD = 12
export const DEFAULT_CHANGED_BLOCK_THRESHOLD = 0.08
export const DEFAULT_MIN_SELECTION_SEPARATION_MS = 1000
export const DEFAULT_OBSERVATION_WINDOW_MS = 6000

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

function meanLuma(frame) {
    let sum = 0
    for (const value of frame) sum += value
    return frame.length ? sum / frame.length : 0
}

function compensateGlobalBrightness(reference, candidate) {
    const shift = meanLuma(candidate) - meanLuma(reference)
    if (Math.abs(shift) < 1) return candidate

    const adjusted = Buffer.allocUnsafe(candidate.length)
    for (let i = 0; i < candidate.length; i++) {
        adjusted[i] = Math.max(0, Math.min(255, Math.round(candidate[i] - shift)))
    }
    return adjusted
}

export function calculateBrightnessCompensatedBlockLumaDifference(reference, candidate, options = {}) {
    return calculateBlockLumaDifference(reference, compensateGlobalBrightness(reference, candidate), options)
}

function distanceValue(difference) {
    return round(difference.changedBlockRatio + difference.differenceScore)
}

function pairDiagnostic(pair, difference) {
    return {
        pair,
        score: distanceValue(difference),
        differenceScore: difference.differenceScore,
        changedBlockRatio: difference.changedBlockRatio
    }
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
        minSeparationMs = DEFAULT_MIN_SELECTION_SEPARATION_MS,
        observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS
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
        this.observationWindowMs = observationWindowMs
        this.candidates = []
        this.candidateFramesEvaluated = 0
        this.firstCleanFrameAt = null
        this.finalized = false
    }

    compare(reference, candidate) {
        return calculateBrightnessCompensatedBlockLumaDifference(reference.luma, candidate.luma, {
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
        if (this.finalized) return { selected: false, reason: 'selection_finalized' }

        const record = { ...candidate, index: this.candidates.length }
        this.candidates.push(record)
        this.candidateFramesEvaluated++

        if (this.candidates.length === 1) {
            this.firstCleanFrameAt = candidate.observedAt || null
            return {
                selected: true,
                reason: 'first_clean_frame',
                differenceScore: 0,
                changedBlockRatio: 0,
                record
            }
        }

        const difference = this.compare(this.candidates[0], record)
        return {
            selected: false,
            reason: difference.changedBlockRatio >= this.changedBlockThreshold ? 'buffered_visual_change' : 'buffered_candidate',
            ...difference,
            record
        }
    }

    findBestPair(requireSeparation) {
        const first = this.candidates[0]
        let best = null

        for (let i = 1; i < this.candidates.length - 1; i++) {
            const second = this.candidates[i]
            if (requireSeparation && (second.elapsedMs - first.elapsedMs) < this.minSeparationMs) continue

            for (let j = i + 1; j < this.candidates.length; j++) {
                const third = this.candidates[j]
                if (requireSeparation && (third.elapsedMs - second.elapsedMs) < this.minSeparationMs) continue

                const d12 = this.compare(first, second)
                const d23 = this.compare(second, third)
                const d13 = this.compare(first, third)
                const diversity = round(distanceValue(d12) + distanceValue(d23) + distanceValue(d13))
                const span = third.elapsedMs - first.elapsedMs
                const balance = Math.min(second.elapsedMs - first.elapsedMs, third.elapsedMs - second.elapsedMs)

                if (!best || diversity > best.diversity ||
                    (diversity === best.diversity && span > best.span) ||
                    (diversity === best.diversity && span === best.span && balance > best.balance)) {
                    best = { second, third, d12, d23, d13, diversity, span, balance, usedMinimumSeparation: requireSeparation }
                }
            }
        }

        return best
    }

    finalizeBuffered() {
        if (this.finalized) throw new Error('Adaptive KI Burst selection was already finalized')
        if (this.candidates.length < this.frameCount) {
            throw new Error(`Adaptive KI Burst needs at least ${this.frameCount} clean decoded candidates, received ${this.candidates.length}`)
        }

        const first = this.candidates[0]
        const best = this.findBestPair(true) || this.findBestPair(false)
        if (!best) throw new Error('Adaptive KI Burst could not choose three chronological clean frames')

        const reason = best.usedMinimumSeparation ? 'global_diversity' : 'low_diversity_fallback'
        const selected = [
            { ...first, reason: 'first_clean_frame', differenceScore: 0, changedBlockRatio: 0 },
            { ...best.second, reason, ...best.d12 },
            { ...best.third, reason, ...best.d23 }
        ]
        this.finalized = true

        return {
            selected,
            diagnostics: {
                selectionMode: ADAPTIVE_SELECTION_MODE,
                observationWindowMs: this.observationWindowMs,
                candidateFramesEvaluated: this.candidateFramesEvaluated,
                actualFrameOffsetsMs: selected.map(frame => Math.round(frame.elapsedMs - first.elapsedMs)),
                differenceScores: selected.map(frame => frame.differenceScore),
                changedBlockRatios: selected.map(frame => frame.changedBlockRatio),
                pairwiseDifferenceScores: [
                    pairDiagnostic('F1-F2', best.d12),
                    pairDiagnostic('F2-F3', best.d23),
                    pairDiagnostic('F1-F3', best.d13)
                ],
                totalDiversityScore: best.diversity,
                selectionReasons: selected.map(frame => frame.reason),
                selectionThreshold: this.changedBlockThreshold,
                minimumSelectionSeparationMs: this.minSeparationMs,
                firstCleanFrameAt: this.firstCleanFrameAt
            }
        }
    }
}
