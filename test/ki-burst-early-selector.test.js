import test from 'node:test'
import assert from 'node:assert/strict'
import {
    AdaptiveFrameSelector,
    DEFAULT_FALLBACK_SELECTION_WINDOW_MS,
    DEFAULT_MIN_SELECTION_SEPARATION_MS,
    DEFAULT_OBSERVATION_WINDOW_MS
} from '../lib/streaming/adaptive-frame-selector.js'
import { composeKiBurstFrames } from '../lib/ki-burst-output.js'

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

function candidate(luma, elapsedMs, sourceIndex) {
    return {
        clean: true,
        luma,
        elapsedMs,
        sourceIndex,
        pts: elapsedMs * 90,
        ptsTime: elapsedMs / 1000,
        observedAt: `2026-09-11T10:00:${String(Math.floor(elapsedMs / 1000)).padStart(2, '0')}.000Z`
    }
}

function finalize(frames) {
    const selector = new AdaptiveFrameSelector()
    for (const [elapsedMs, luma, sourceIndex] of frames) selector.evaluate(candidate(luma, elapsedMs, sourceIndex))
    return selector.finalizeBuffered()
}

test('F2 is the first clean WebRTC candidate', () => {
    const base = baseFrame()
    const result = finalize([
        [0, patch(base, 8, 20, 35, 45, 190), 10],
        [1000, patch(base, 48, 20, 35, 45, 190), 20],
        [2000, patch(base, 88, 20, 35, 45, 190), 30],
        [6000, patch(base, 118, 20, 35, 45, 190), 40]
    ])

    assert.equal(result.selected[0].sourceIndex, 10)
    assert.equal(result.selected[0].reason, 'first_clean_frame')
})

test('F3 is never earlier than F2 plus 1000 ms', () => {
    const base = baseFrame()
    const result = finalize([
        [0, base, 0],
        [250, patch(base, 10, 20, 60, 50, 210), 1],
        [750, patch(base, 20, 20, 60, 50, 210), 2],
        [1000, patch(base, 30, 20, 60, 50, 210), 3],
        [1250, patch(base, 40, 20, 60, 50, 210), 4],
        [2250, patch(base, 80, 20, 60, 50, 210), 5]
    ])

    assert.ok(result.selected[1].elapsedMs - result.selected[0].elapsedMs >= DEFAULT_MIN_SELECTION_SEPARATION_MS)
})

test('static scene does not send F3 to the end of the 6000 ms observation window', () => {
    const base = baseFrame()
    const frames = []
    for (let elapsedMs = 0, index = 0; elapsedMs <= 6000; elapsedMs += 500, index++) {
        frames.push([elapsedMs, Buffer.from(base), index])
    }
    const result = finalize(frames)

    assert.equal(DEFAULT_OBSERVATION_WINDOW_MS, 6000)
    assert.ok(result.selected[1].elapsedMs <= 1500)
    assert.notEqual(result.selected[1].elapsedMs, 6000)
})

test('low-diversity fallback stays early instead of stretching to 6000 ms', () => {
    const base = baseFrame()
    const frames = [
        [0, base, 0],
        [1000, patch(base, 10, 20, 8, 8, 92), 1],
        [1500, patch(base, 14, 20, 8, 8, 94), 2],
        [2500, patch(base, 18, 20, 8, 8, 96), 3],
        [6000, patch(base, 80, 20, 70, 55, 220), 4]
    ]
    const result = finalize(frames)

    assert.match(result.selected[1].reason, /^early_low_diversity_/)
    assert.ok(result.selected[1].elapsedMs <= DEFAULT_FALLBACK_SELECTION_WINDOW_MS)
    assert.notEqual(result.selected[1].sourceIndex, 4)
})

test('fast pass keeps the earliest usable first-clean frame as final F2 input', () => {
    const base = baseFrame()
    const firstClean = patch(base, 5, 18, 48, 50, 205)
    const result = finalize([
        [0, firstClean, 100],
        [1050, patch(base, 48, 18, 48, 50, 205), 101],
        [2100, patch(base, 96, 18, 48, 50, 205), 102],
        [6000, base, 103]
    ])

    assert.equal(result.selected[0].sourceIndex, 100)
    assert.equal(result.selected[0].elapsedMs, 0)
    assert.equal(result.selected[1].sourceIndex, 101)
})

test('existing minimum 1000 ms separation guard is preserved for published WebRTC pair', () => {
    const base = baseFrame()
    const result = finalize([
        [0, base, 0],
        [250, patch(base, 5, 15, 65, 55, 210), 1],
        [900, patch(base, 15, 15, 65, 55, 210), 2],
        [1300, patch(base, 25, 15, 65, 55, 210), 3],
        [2450, patch(base, 90, 15, 65, 55, 210), 4],
        [6000, patch(base, 100, 20, 50, 45, 200), 5]
    ])

    assert.equal(result.selected[0].sourceIndex, 0)
    assert.ok(result.selected[1].elapsedMs - result.selected[0].elapsedMs >= 1000)
})

test('Motion Snapshot remains final F1 while first clean and early adaptive candidates become final F2/F3', () => {
    const composed = composeKiBurstFrames({
        snapshot: Buffer.from('MOTION_SNAPSHOT'),
        snapshotType: 'motion',
        snapshotTimestamp: 100,
        expectedMotionTimestamp: 100,
        currentMotionTimestamp: 100,
        selectedFrames: [
            Buffer.from('FIRST_CLEAN'),
            Buffer.from('EARLY_ADAPTIVE'),
            Buffer.from('COMPATIBILITY_TAIL')
        ]
    })

    assert.deepEqual(composed.frames.map(frame => frame.toString()), [
        'MOTION_SNAPSHOT',
        'FIRST_CLEAN',
        'EARLY_ADAPTIVE'
    ])
})
