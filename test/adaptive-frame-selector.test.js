import test from 'node:test'
import assert from 'node:assert/strict'
import {
    ADAPTIVE_SELECTION_MODE,
    AdaptiveFrameSelector,
    DEFAULT_CHANGED_BLOCK_THRESHOLD,
    DEFAULT_FALLBACK_SELECTION_WINDOW_MS,
    DEFAULT_MIN_SELECTION_SEPARATION_MS,
    DEFAULT_OBSERVATION_WINDOW_MS,
    calculateBlockLumaDifference,
    calculateBrightnessCompensatedBlockLumaDifference
} from '../lib/streaming/adaptive-frame-selector.js'

const WIDTH = 160
const HEIGHT = 90
const FRAME_BYTES = WIDTH * HEIGHT

function baseFrame(value = 80) {
    return Buffer.alloc(FRAME_BYTES, value)
}

function patch(source, x0, y0, width, height, value) {
    const frame = Buffer.from(source)
    for (let y = y0; y < Math.min(HEIGHT, y0 + height); y++) {
        for (let x = x0; x < Math.min(WIDTH, x0 + width); x++) {
            frame[(y * WIDTH) + x] = value
        }
    }
    return frame
}

function codecNoise(source, amount = 2) {
    const frame = Buffer.from(source)
    for (let i = 0; i < frame.length; i++) {
        frame[i] = Math.max(0, Math.min(255, frame[i] + (((i % 5) - 2) * amount)))
    }
    return frame
}

function brightnessShift(source, amount) {
    const frame = Buffer.from(source)
    for (let i = 0; i < frame.length; i++) frame[i] = Math.max(0, Math.min(255, frame[i] + amount))
    return frame
}

function candidate(luma, elapsedMs, extra = {}) {
    return {
        luma,
        elapsedMs,
        clean: true,
        sourceIndex: extra.sourceIndex ?? Math.round(elapsedMs / 100),
        pts: extra.pts ?? elapsedMs * 90,
        ptsTime: extra.ptsTime ?? elapsedMs / 1000,
        observedAt: extra.observedAt ?? `2026-09-06T08:00:${String(Math.floor(elapsedMs / 1000)).padStart(2, '0')}.000Z`,
        ...extra
    }
}

function add(selector, frames) {
    frames.forEach(([elapsedMs, luma, extra]) => selector.evaluate(candidate(luma, elapsedMs, extra)))
}

test('buffering still waits for caller to end the 6000 ms observation window', () => {
    const selector = new AdaptiveFrameSelector()
    const door = baseFrame()

    selector.evaluate(candidate(door, 0))
    selector.evaluate(candidate(patch(door, 10, 15, 55, 45, 210), 1100))
    selector.evaluate(candidate(patch(door, 18, 15, 55, 45, 210), 2200))

    assert.equal(selector.finalized, false)
    assert.equal(selector.candidateFramesEvaluated, 3)
    selector.evaluate(candidate(patch(door, 75, 20, 55, 45, 210), DEFAULT_OBSERVATION_WINDOW_MS))
    assert.equal(selector.finalized, false)

    const result = selector.finalizeBuffered()
    assert.equal(result.selected.length, 3)
    assert.equal(result.diagnostics.selectionMode, ADAPTIVE_SELECTION_MODE)
    assert.equal(result.diagnostics.observationWindowMs, 6000)
})

test('early visual change is selected instead of maximizing diversity across the full observation window', () => {
    const selector = new AdaptiveFrameSelector()
    const door = baseFrame()
    const early = patch(door, 8, 18, 65, 55, 200)
    const later = patch(door, 60, 18, 65, 55, 200)
    const end = patch(door, 95, 18, 60, 55, 220)

    add(selector, [
        [0, door, { sourceIndex: 0 }],
        [1100, early, { sourceIndex: 1 }],
        [2200, later, { sourceIndex: 2 }],
        [6000, end, { sourceIndex: 3 }]
    ])

    const result = selector.finalizeBuffered()
    assert.equal(result.selected[0].sourceIndex, 0)
    assert.equal(result.selected[1].sourceIndex, 1)
    assert.match(result.selected[1].reason, /^early_visual_change_/)
    assert.notEqual(result.selected[1].sourceIndex, 3)
})

test('global exposure shift is compensated and cannot force a late selection', () => {
    const selector = new AdaptiveFrameSelector()
    const door = baseFrame(70)
    const exposureOnly = brightnessShift(door, 45)
    const latePath = patch(brightnessShift(door, 45), 95, 18, 60, 52, 210)

    const exposureDifference = calculateBrightnessCompensatedBlockLumaDifference(door, exposureOnly)
    assert.ok(exposureDifference.changedBlockRatio < DEFAULT_CHANGED_BLOCK_THRESHOLD)
    assert.ok(exposureDifference.differenceScore < 0.01)

    add(selector, [
        [0, door, { sourceIndex: 0 }],
        [1200, exposureOnly, { sourceIndex: 1 }],
        [2200, exposureOnly, { sourceIndex: 2 }],
        [6000, latePath, { sourceIndex: 3 }]
    ])

    const result = selector.finalizeBuffered()
    assert.equal(result.selected[1].sourceIndex, 1)
    assert.match(result.selected[1].reason, /^early_low_diversity_/)
})

test('static scene returns an early chronological set and never stretches the adaptive frame to 6000 ms', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    for (const [index, elapsedMs] of [0, 1000, 2000, 3000, 4000, 5000, 6000].entries()) {
        selector.evaluate(candidate(Buffer.from(base), elapsedMs, { sourceIndex: index }))
    }

    const result = selector.finalizeBuffered()
    assert.equal(result.selected.length, 3)
    assert.deepEqual(result.selected.map(frame => frame.sourceIndex), [0, 1, 2])
    assert.equal(result.selected[1].elapsedMs, 1000)
    assert.ok(result.selected[1].elapsedMs <= DEFAULT_FALLBACK_SELECTION_WINDOW_MS)
    assert.equal(result.diagnostics.pairwiseDifferenceScores[0].score, 0)
})

test('slow movement keeps first clean and chooses an early changed candidate', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    selector.evaluate(candidate(base, 0, { sourceIndex: 0 }))
    for (let step = 1; step <= 6; step++) {
        selector.evaluate(candidate(patch(base, 8 + (step * 16), 28, 36, 38, 195), step * 1000, { sourceIndex: step }))
    }

    const result = selector.finalizeBuffered()
    assert.equal(result.selected[0].sourceIndex, 0)
    assert.ok(result.selected[1].elapsedMs >= DEFAULT_MIN_SELECTION_SEPARATION_MS)
    assert.ok(result.selected[1].elapsedMs <= DEFAULT_FALLBACK_SELECTION_WINDOW_MS)
})

test('fast movement uses the first eligible changed candidate and ignores a more diverse late frame', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    add(selector, [
        [0, patch(base, 5, 18, 48, 50, 205), { sourceIndex: 0 }],
        [1050, patch(base, 56, 18, 48, 50, 205), { sourceIndex: 1 }],
        [2100, patch(base, 107, 18, 48, 50, 205), { sourceIndex: 2 }],
        [6000, base, { sourceIndex: 3 }]
    ])

    const result = selector.finalizeBuffered()
    assert.equal(result.selected[0].sourceIndex, 0)
    assert.equal(result.selected[1].sourceIndex, 1)
})

test('damaged/non-clean candidate is never admitted to buffered selection', () => {
    const selector = new AdaptiveFrameSelector()
    const damaged = selector.evaluate({
        luma: patch(baseFrame(), 0, 0, 100, 80, 220),
        elapsedMs: 0,
        clean: false
    })

    assert.equal(damaged.selected, false)
    assert.equal(damaged.reason, 'not_clean')
    assert.equal(selector.candidateFramesEvaluated, 0)
    assert.equal(selector.candidates.length, 0)
})

test('minimum separation remains a hard guard for the first adaptive candidate', () => {
    const selector = new AdaptiveFrameSelector({ minSeparationMs: 1000 })
    const base = baseFrame()
    add(selector, [
        [0, base, { sourceIndex: 0 }],
        [250, patch(base, 5, 15, 65, 55, 210), { sourceIndex: 1 }],
        [900, patch(base, 15, 15, 65, 55, 210), { sourceIndex: 2 }],
        [1300, patch(base, 25, 15, 65, 55, 210), { sourceIndex: 3 }],
        [2450, patch(base, 90, 15, 65, 55, 210), { sourceIndex: 4 }],
        [6000, patch(base, 100, 20, 50, 45, 200), { sourceIndex: 5 }]
    ])

    const result = selector.finalizeBuffered()
    assert.equal(result.selected[1].sourceIndex, 3)
    assert.ok(result.selected[1].elapsedMs - result.selected[0].elapsedMs >= 1000)
})

test('block luma difference still suppresses tiny codec noise', () => {
    const base = baseFrame()
    const difference = calculateBlockLumaDifference(base, codecNoise(base))
    assert.ok(difference.changedBlockRatio < DEFAULT_CHANGED_BLOCK_THRESHOLD)
})

test('88-candidate finalization remains bounded after removing global triple search', () => {
    const selector = new AdaptiveFrameSelector({ minSeparationMs: 1000 })
    const base = baseFrame(70)
    let expensiveComparisons = 0
    const originalCompare = selector.compare.bind(selector)
    selector.compare = (reference, current) => {
        expensiveComparisons++
        return originalCompare(reference, current)
    }

    for (let i = 0; i < 88; i++) {
        const elapsedMs = Math.round((i * 6000) / 87)
        const x = (i * 7) % 125
        const frame = patch(base, x, 18, 35, 45, 120 + (i % 100))
        selector.evaluate(candidate(frame, elapsedMs, { sourceIndex: i, pts: i * 4500, ptsTime: elapsedMs / 1000 }))
    }

    expensiveComparisons = 0
    const result = selector.finalizeBuffered()

    assert.equal(result.selected.length, 3)
    assert.ok(expensiveComparisons < 200, `early selection performed ${expensiveComparisons} expensive luma comparisons`)
})
