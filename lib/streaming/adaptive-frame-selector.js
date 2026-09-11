export const ADAPTIVE_SELECTION_MODE = 'adaptive_buffered'
export const DEFAULT_ANALYSIS_WIDTH = 160
export const DEFAULT_ANALYSIS_HEIGHT = 90
export const DEFAULT_BLOCK_SIZE = 8
export const DEFAULT_PIXEL_NOISE_FLOOR = 4
export const DEFAULT_BLOCK_LUMA_THRESHOLD = 12
export const DEFAULT_CHANGED_BLOCK_THRESHOLD = 0.08
export const DEFAULT_MIN_SELECTION_SEPARATION_MS = 1000
export const DEFAULT_PRIMARY_SELECTION_WINDOW_MS = 1500
export const DEFAULT_FALLBACK_SELECTION_WINDOW_MS = 2500
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
            for (let py = y0; py < yEnd; py++) {
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
        primarySelectionWindowMs = DEFAULT_PRIMARY_SELECTION_WINDOW_MS,
        fallbackSelectionWindowMs = DEFAULT_FALLBACK_SELECTION_WINDOW_MS,
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
        this.primarySelectionWindowMs = primarySelectionWindowMs
        this.fallbackSelectionWindowMs = fallbackSelectionWindowMs
        this.observationWindowMs = observationWindowMs
        this.candidates = []
        this.candidateFramesEvaluated = 0
        this.firstCleanFrameAt = null
        this.finalized = false
        this.pairDifferenceCache = new Map()
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

    getPairDifference(reference, candidate) {
        const canCache = Number.isInteger(reference?.index) && Number.isInteger(candidate?.index)
        const key = canCache ? `${reference.index}:${candidate.index}` : null
        if (key !== null && this.pairDifferenceCache.has(key)) return this.pairDifferenceCache.get(key)

        const difference = this.compare(reference, candidate)
        if (key !== null) this.pairDifferenceCache.set(key, difference)
        return difference
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

        const difference = this.getPairDifference(this.candidates[0], record)
        return {
            selected: false,
            reason: difference.changedBlockRatio >= this.changedBlockThreshold ? 'buffered_visual_change' : 'buffered_candidate',
            ...difference,
            record
        }
    }

    findEarlyAdaptiveCandidate() {
        const first = this.candidates[0]
        const minimumElapsed = first.elapsedMs + this.minSeparationMs
        const primaryEnd = first.elapsedMs + Math.max(this.minSeparationMs, this.primarySelectionWindowMs)
        const fallbackEnd = first.elapsedMs + Math.max(this.minSeparationMs, this.fallbackSelectionWindowMs)
        const eligible = this.candidates
            .slice(1)
            .filter(candidate => candidate.elapsedMs >= minimumElapsed && candidate.elapsedMs <= fallbackEnd)

        if (!eligible.length) return null

        for (const candidate of eligible) {
            const difference = this.getPairDifference(first, candidate)
            if (difference.changedBlockRatio >= this.changedBlockThreshold) {
                return {
                    candidate,
                    difference,
                    reason: candidate.elapsedMs <= primaryEnd ? 'early_visual_change_primary' : 'early_visual_change_fallback'
                }
            }
        }

        const primaryCandidates = eligible.filter(candidate => candidate.elapsedMs <= primaryEnd)
        const fallbackPool = primaryCandidates.length ? primaryCandidates : eligible
        let best = null
        for (const candidate of fallbackPool) {
            const difference = this.getPairDifference(first, candidate)
            const score = distanceValue(difference)
            if (!best || score > best.score || (score === best.score && candidate.elapsedMs < best.candidate.elapsedMs)) {
                best = { candidate, difference, score }
            }
        }

        return {
            candidate: best.candidate,
            difference: best.difference,
            reason: primaryCandidates.length ? 'early_low_diversity_primary' : 'early_low_diversity_fallback'
        }
    }

    findCompatibilityTail(second) {
        const separated = this.candidates.find(candidate =>
            candidate.index > second.index && (candidate.elapsedMs - second.elapsedMs) >= this.minSeparationMs
        )
        if (separated) return separated
        return this.candidates.find(candidate => candidate.index > second.index) || null
    }

    finalizeBuffered() {
        if (this.finalized) throw new Error('Adaptive KI Burst selection was already finalized')
        if (this.candidates.length < this.frameCount) {
            throw new Error(`Adaptive KI Burst needs at least ${this.frameCount} clean decoded candidates, received ${this.candidates.length}`)
        }

        const first = this.candidates[0]
        const early = this.findEarlyAdaptiveCandidate()
        if (!early) {
            throw new Error(`Adaptive KI Burst could not find an early candidate at least ${this.minSeparationMs} ms after first clean within ${this.fallbackSelectionWindowMs} ms`)
        }

        const tail = this.findCompatibilityTail(early.candidate)
        if (!tail) throw new Error('Adaptive KI Burst could not choose a third chronological compatibility frame')

        const d12 = early.difference
        const d23 = this.getPairDifference(early.candidate, tail)
        const d13 = this.getPairDifference(first, tail)
        const diversity = round(distanceValue(d12) + distanceValue(d23) + distanceValue(d13))
        const selected = [
            { ...first, reason: 'first_clean_frame', differenceScore: 0, changedBlockRatio: 0 },
            { ...early.candidate, reason: early.reason, ...d12 },
            { ...tail, reason: 'compatibility_tail', ...d23 }
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
                    pairDiagnostic('F1-F2', d12),
                    pairDiagnostic('F2-F3', d23),
                    pairDiagnostic('F1-F3', d13)
                ],
                totalDiversityScore: diversity,
                selectionReasons: selected.map(frame => frame.reason),
                selectionThreshold: this.changedBlockThreshold,
                minimumSelectionSeparationMs: this.minSeparationMs,
                primarySelectionWindowMs: this.primarySelectionWindowMs,
                fallbackSelectionWindowMs: this.fallbackSelectionWindowMs,
                firstCleanFrameAt: this.firstCleanFrameAt
            }
        }
    }
}
