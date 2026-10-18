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
// F3 is taken from this window (relative to F2) so that a person walking up the
// path is clearly closer than in F1/F2. Real walks show a 1-2.5 s gap is still
// the same far-away picture; the burst always lasts the full observation window
// anyway, so a later F3 does not delay the result.
export const DEFAULT_SPREAD_WINDOW_START_MS = 3500
export const DEFAULT_SPREAD_WINDOW_END_MS = 5500

// Closest-person selection (F3): the person's apparent size is measured on RGB analysis
// frames, because a dark jacket and dark asphalt look alike in luma but differ in colour.
export const DEFAULT_PERSON_CELL_SIZE = 2
export const DEFAULT_PERSON_COLOR_THRESHOLD = 40
export const DEFAULT_PERSON_MIN_AREA_CELLS = 6
export const DEFAULT_PERSON_VISIBLE_RATIO = 0.1

export function rgbToLuma(rgb, pixels = DEFAULT_ANALYSIS_WIDTH * DEFAULT_ANALYSIS_HEIGHT) {
    const luma = Buffer.allocUnsafe(pixels)
    for (let i = 0; i < pixels; i++) {
        luma[i] = (rgb[i * 3] * 299 + rgb[(i * 3) + 1] * 587 + rgb[(i * 3) + 2] * 114) / 1000
    }
    return luma
}

function reduceRgb(rgb, width, height, cell) {
    const w = Math.floor(width / cell)
    const h = Math.floor(height / cell)
    const out = new Uint8Array(w * h * 3)
    const area = cell * cell
    for (let cy = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0
                for (let dy = 0; dy < cell; dy++) {
                    for (let dx = 0; dx < cell; dx++) {
                        sum += rgb[((((cy * cell) + dy) * width) + (cx * cell) + dx) * 3 + c]
                    }
                }
                out[((cy * w) + cx) * 3 + c] = Math.round(sum / area)
            }
        }
    }
    return { cells: out, count: w * h }
}

function medianOf(values) {
    values.sort((a, b) => a - b)
    return values[values.length >> 1]
}

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
        primarySelectionWindowMs = DEFAULT_PRIMARY_SELECTION_WINDOW_MS,
        fallbackSelectionWindowMs = DEFAULT_FALLBACK_SELECTION_WINDOW_MS,
        observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS,
        spreadWindowStartMs = DEFAULT_SPREAD_WINDOW_START_MS,
        spreadWindowEndMs = DEFAULT_SPREAD_WINDOW_END_MS,
        personColorThreshold = DEFAULT_PERSON_COLOR_THRESHOLD,
        personMinAreaCells = DEFAULT_PERSON_MIN_AREA_CELLS,
        personVisibleRatio = DEFAULT_PERSON_VISIBLE_RATIO
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
        this.spreadWindowStartMs = spreadWindowStartMs
        this.spreadWindowEndMs = spreadWindowEndMs
        this.personColorThreshold = personColorThreshold
        this.personMinAreaCells = personMinAreaCells
        this.personVisibleRatio = personVisibleRatio
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

    // Estimates the foreground (person) area of every candidate against a per-cell median
    // background and returns the last candidate in which the person is still clearly visible.
    // Returns null when RGB frames are missing or nothing stands out.
    findLastVisiblePersonCandidate() {
        const first = this.candidates[0]
        const rgbBytes = this.width * this.height * 3
        if (this.candidates.length < 5 || !this.candidates.every(candidate => Buffer.isBuffer(candidate.rgb) && candidate.rgb.length === rgbBytes)) {
            return null
        }

        const end = first.elapsedMs + Math.min(this.observationWindowMs, this.spreadWindowEndMs + 1000)
        const lastIndex = this.candidates.length - 1
        const eligible = this.candidates.filter(candidate =>
            candidate.index > 0 &&
            candidate.index < lastIndex &&
            candidate.elapsedMs >= first.elapsedMs + this.minSeparationMs &&
            candidate.elapsedMs <= end
        )
        if (!eligible.length) return null

        const reduced = this.candidates.map(candidate => reduceRgb(candidate.rgb, this.width, this.height, DEFAULT_PERSON_CELL_SIZE))
        const cellCount = reduced[0].count
        const background = new Uint8Array(cellCount * 3)
        const column = new Array(reduced.length)
        for (let i = 0; i < cellCount * 3; i++) {
            for (let k = 0; k < reduced.length; k++) column[k] = reduced[k].cells[i]
            background[i] = medianOf(column)
        }

        const areaOf = candidateIndex => {
            const cells = reduced[candidateIndex].cells
            // Global exposure/white-balance drift is removed per channel before counting.
            const shift = [0, 0, 0]
            for (let c = 0; c < 3; c++) {
                const sample = []
                for (let i = 0; i < cellCount; i += 7) sample.push(cells[(i * 3) + c] - background[(i * 3) + c])
                shift[c] = medianOf(sample)
            }
            let area = 0
            for (let i = 0; i < cellCount; i++) {
                const distance = Math.abs(cells[i * 3] - background[i * 3] - shift[0]) +
                    Math.abs(cells[(i * 3) + 1] - background[(i * 3) + 1] - shift[1]) +
                    Math.abs(cells[(i * 3) + 2] - background[(i * 3) + 2] - shift[2])
                if (distance > this.personColorThreshold) area++
            }
            return area
        }

        const measured = eligible.map(candidate => ({ candidate, area: areaOf(candidate.index) }))
        const peak = measured.reduce((max, item) => Math.max(max, item.area), 0)
        if (peak < this.personMinAreaCells) return null

        // The person is judged by where they end up, not by where they were largest: someone who
        // steps out of the door and walks away is biggest at the door, so "closest" would show the
        // turn at the door instead of the departure. The last candidate in which the person is still
        // clearly visible (at least personVisibleRatio of the peak area) shows the end of the movement;
        // an arrival still ends at the door, a departure ends on the way out.
        const threshold = Math.max(this.personMinAreaCells, peak * this.personVisibleRatio)
        let last = null
        for (const item of measured) {
            if (item.area >= threshold) last = item
        }

        return {
            candidate: last.candidate,
            difference: this.getPairDifference(first, last.candidate),
            reason: 'last_visible_person',
            personAreaCells: last.area,
            personPeakAreaCells: peak
        }
    }

    findSpreadCandidate() {
        const first = this.candidates[0]
        const start = first.elapsedMs + this.spreadWindowStartMs
        const end = first.elapsedMs + this.spreadWindowEndMs
        const eligible = this.candidates
            .slice(1)
            // A later candidate must exist, because the selection contract needs a chronological third frame.
            .filter(candidate => candidate.elapsedMs >= start && candidate.elapsedMs <= end && candidate.index < this.candidates.length - 1)

        if (!eligible.length) return null

        for (const candidate of eligible) {
            const difference = this.getPairDifference(first, candidate)
            if (difference.changedBlockRatio >= this.changedBlockThreshold) {
                return { candidate, difference, reason: 'spread_visual_change' }
            }
        }

        let best = null
        for (const candidate of eligible) {
            const difference = this.getPairDifference(first, candidate)
            const score = distanceValue(difference)
            if (!best || score > best.score) best = { candidate, difference, score }
        }
        return { candidate: best.candidate, difference: best.difference, reason: 'spread_low_diversity_fallback' }
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

        // Candidates are chronological. This intentionally makes the first candidate
        // that crosses the existing visual-change gate win; global diversity and
        // maximum-span tie-breaks no longer influence F3.
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

        // No candidate reached the gate. Pick the visually best candidate from the
        // complete bounded fallback window, with an EARLIER tie-break. The 2500 ms
        // cap prevents low-diversity scenes from drifting to the end of observation.
        let best = null
        for (const candidate of eligible) {
            const difference = this.getPairDifference(first, candidate)
            const score = distanceValue(difference)
            if (!best || score > best.score || (score === best.score && candidate.elapsedMs < best.candidate.elapsedMs)) {
                best = { candidate, difference, score }
            }
        }

        return {
            candidate: best.candidate,
            difference: best.difference,
            reason: 'early_low_diversity_fallback'
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
        // Prefer the last frame with a clearly visible person; without RGB/foreground fall back to the spread window, then to the early selection.
        const early = this.findLastVisiblePersonCandidate() || this.findSpreadCandidate() || this.findEarlyAdaptiveCandidate()
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
                spreadSelectionWindowMs: [this.spreadWindowStartMs, this.spreadWindowEndMs],
                primarySelectionWindowMs: this.primarySelectionWindowMs,
                fallbackSelectionWindowMs: this.fallbackSelectionWindowMs,
                firstCleanFrameAt: this.firstCleanFrameAt
            }
        }
    }
}
