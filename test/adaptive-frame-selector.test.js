import test from 'node:test'
import assert from 'node:assert/strict'
import {
    AdaptiveFrameSelector,
    DEFAULT_CHANGED_BLOCK_THRESHOLD,
    DEFAULT_MIN_SELECTION_SEPARATION_MS,
    calculateBlockLumaDifference
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

function candidate(luma, elapsedMs, extra = {}) {
    return { luma, elapsedMs, clean: true, ...extra }
}

test('adaptive selector uses first clean frame and falls back to exactly three chronological frames for a static scene', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    for (const elapsedMs of [0, 500, 1000, 1500, 2000]) {
        selector.evaluate(candidate(Buffer.from(base), elapsedMs))
    }

    const result = selector.finalizeFallback()
    assert.equal(result.selected.length, 3)
    assert.deepEqual(result.diagnostics.selectionReasons, ['first_clean_frame', 'timeout_best_candidate', 'timeout_best_candidate'])
    assert.equal(result.diagnostics.selectionMode, 'adaptive')
    assert.equal(result.diagnostics.selectionThreshold, DEFAULT_CHANGED_BLOCK_THRESHOLD)
    assert.ok(result.selected[0].elapsedMs < result.selected[1].elapsedMs)
    assert.ok(result.selected[1].elapsedMs < result.selected[2].elapsedMs)
})

test('small codec/noise-only luma changes stay below the changed-block threshold', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    selector.evaluate(candidate(base, 0))
    const outcome = selector.evaluate(candidate(codecNoise(base), DEFAULT_MIN_SELECTION_SEPARATION_MS))

    assert.equal(outcome.selected, false)
    assert.equal(outcome.reason, 'below_motion_threshold')
    assert.ok(outcome.changedBlockRatio < DEFAULT_CHANGED_BLOCK_THRESHOLD)
})

test('slow movement is evaluated repeatedly and selected only after enough visual displacement accumulates', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    selector.evaluate(candidate(base, 0))

    let selected = null
    for (let step = 1; step <= 8; step++) {
        const moved = patch(base, step * 4, 25, 30, 30, 190)
        const outcome = selector.evaluate(candidate(moved, step * 500))
        if (outcome.selected) {
            selected = outcome
            break
        }
    }

    assert.ok(selected)
    assert.equal(selected.reason, 'motion_displacement')
    assert.ok(selected.changedBlockRatio >= DEFAULT_CHANGED_BLOCK_THRESHOLD)
})

test('fast movement selects new displacement stages without fixed target offsets', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()

    assert.equal(selector.evaluate(candidate(base, 0)).selected, true)
    assert.equal(selector.evaluate(candidate(patch(base, 10, 20, 50, 40, 200), 500)).selected, true)
    assert.equal(selector.evaluate(candidate(patch(base, 90, 20, 50, 40, 200), 1000)).selected, true)

    const result = selector.result()
    assert.equal(result.selected.length, 3)
    assert.deepEqual(result.diagnostics.selectionReasons, ['first_clean_frame', 'motion_displacement', 'motion_displacement'])
    assert.deepEqual(result.diagnostics.actualFrameOffsetsMs, [0, 500, 1000])
})

test('insufficient movement until timeout completes through best-candidate fallback instead of failure', () => {
    const selector = new AdaptiveFrameSelector()
    const base = baseFrame()
    for (const elapsedMs of [0, 500, 1100, 1700, 2400]) {
        selector.evaluate(candidate(codecNoise(base, 1), elapsedMs))
    }

    const result = selector.finalizeFallback()
    assert.equal(result.selected.length, 3)
    assert.equal(result.diagnostics.candidateFramesEvaluated, 5)
    assert.deepEqual(result.diagnostics.selectionReasons, ['first_clean_frame', 'timeout_best_candidate', 'timeout_best_candidate'])
})

test('damaged/non-clean candidate is never admitted to adaptive selection', () => {
    const selector = new AdaptiveFrameSelector()
    const damaged = selector.evaluate({
        luma: patch(baseFrame(), 0, 0, 100, 80, 220),
        elapsedMs: 0,
        clean: false
    })

    assert.equal(damaged.selected, false)
    assert.equal(damaged.reason, 'not_clean')
    assert.equal(selector.candidateFramesEvaluated, 0)
    assert.equal(selector.selected.length, 0)
})

test('block luma difference suppresses tiny pixel noise', () => {
    const base = baseFrame()
    const difference = calculateBlockLumaDifference(base, codecNoise(base))
    assert.ok(difference.changedBlockRatio < DEFAULT_CHANGED_BLOCK_THRESHOLD)
})
