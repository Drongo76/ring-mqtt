import test from 'node:test'
import assert from 'node:assert/strict'
import { AdaptiveFrameSelector } from '../lib/streaming/adaptive-frame-selector.js'
import { evaluateCandidatePts } from '../lib/streaming/build12-streaming-session.js'

const WIDTH = 160
const HEIGHT = 90

function luma(value = 80) {
    return Buffer.alloc(WIDTH * HEIGHT, value)
}

function diagnostic(index, pts, ptsTime) {
    return { index, pts, ptsTime, observedAt: `2026-09-06T10:00:0${index}.000Z`, pictType: index === 0 ? 'I' : 'P' }
}

function admit(selector, state, { sourceIndex, pts, ptsTime, value = 80 }) {
    const decoded = diagnostic(sourceIndex, pts, ptsTime)
    const full = diagnostic(sourceIndex, pts, ptsTime)
    const reduced = diagnostic(sourceIndex, pts, ptsTime)
    const decision = evaluateCandidatePts({
        sourceIndex,
        previousPts: state.previousPts,
        decoded,
        full,
        luma: reduced
    })

    if (!decision.accepted) {
        state.rejections.push(decision.rejection)
        return false
    }

    selector.evaluate({
        clean: true,
        luma: luma(value),
        elapsedMs: Math.round(ptsTime * 1000),
        sourceIndex,
        pts,
        ptsTime,
        observedAt: decoded.observedAt,
        pictType: decoded.pictType,
        rawChecksum: `RAW${sourceIndex}`
    })
    state.previousPts = pts
    return true
}

test('duplicate PTS candidate is skipped and later monotonic candidates still complete exactly three chronological frames', () => {
    const selector = new AdaptiveFrameSelector({ minSeparationMs: 1000, observationWindowMs: 6000 })
    const state = { previousPts: null, rejections: [] }

    assert.equal(admit(selector, state, { sourceIndex: 0, pts: 100, ptsTime: 0, value: 80 }), true)
    assert.equal(admit(selector, state, { sourceIndex: 1, pts: 100, ptsTime: 1, value: 90 }), false)
    assert.equal(admit(selector, state, { sourceIndex: 2, pts: 200, ptsTime: 2, value: 100 }), true)
    assert.equal(admit(selector, state, { sourceIndex: 3, pts: 300, ptsTime: 4, value: 120 }), true)

    const result = selector.finalizeBuffered()
    assert.equal(result.selected.length, 3)
    assert.deepEqual(result.selected.map(frame => frame.sourceIndex), [0, 2, 3])
    assert.deepEqual(result.selected.map(frame => frame.pts), [100, 200, 300])
    assert.equal(state.rejections.length, 1)
    assert.deepEqual(state.rejections[0], {
        sourceIndex: 1,
        previousPts: 100,
        currentPts: 100,
        decodedPts: 100,
        fullPts: 100,
        lumaPts: 100,
        rejectionReason: 'duplicate_pts'
    })
})

test('non-increasing PTS candidate is skipped without changing the previous accepted PTS', () => {
    const previousPts = 500
    const decoded = diagnostic(4, 450, 2)
    const full = diagnostic(4, 450, 2)
    const reduced = diagnostic(4, 450, 2)
    const decision = evaluateCandidatePts({ sourceIndex: 4, previousPts, decoded, full, luma: reduced })

    assert.equal(decision.accepted, false)
    assert.equal(decision.rejection.previousPts, 500)
    assert.equal(decision.rejection.currentPts, 450)
    assert.equal(decision.rejection.decodedPts, 450)
    assert.equal(decision.rejection.fullPts, 450)
    assert.equal(decision.rejection.lumaPts, 450)
    assert.equal(decision.rejection.rejectionReason, 'non_increasing_pts')
})

test('repeated invalid PTS candidates until observation/deadline end produce a clean insufficient-candidate failure', () => {
    const selector = new AdaptiveFrameSelector({ minSeparationMs: 1000, observationWindowMs: 6000 })
    const state = { previousPts: null, rejections: [] }

    assert.equal(admit(selector, state, { sourceIndex: 0, pts: 1000, ptsTime: 0 }), true)
    assert.equal(admit(selector, state, { sourceIndex: 1, pts: 1000, ptsTime: 1 }), false)
    assert.equal(admit(selector, state, { sourceIndex: 2, pts: 999, ptsTime: 2 }), false)
    assert.equal(admit(selector, state, { sourceIndex: 3, pts: 998, ptsTime: 4 }), false)
    assert.equal(admit(selector, state, { sourceIndex: 4, pts: 1000, ptsTime: 6 }), false)

    assert.equal(selector.candidateFramesEvaluated, 1)
    assert.equal(state.rejections.length, 4)
    assert.throws(() => selector.finalizeBuffered(), /needs at least 3 clean decoded candidates, received 1/)
})

test('decoded/full/luma identity mismatch remains a hard rejection', () => {
    const decoded = diagnostic(5, 600, 3)
    const full = diagnostic(5, 601, 3)
    const reduced = diagnostic(5, 600, 3)

    assert.throws(
        () => evaluateCandidatePts({ sourceIndex: 5, previousPts: 500, decoded, full, luma: reduced }),
        /decoded\/full\/luma PTS mismatch at source index 5/
    )
})
