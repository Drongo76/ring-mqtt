import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AdaptiveFrameSelector } from '../lib/streaming/adaptive-frame-selector.js'
import {
    candidateFilenameForSourceIndex,
    inspectCandidateJpegFiles,
    loadSelectedCandidateJpegs,
    restrictSelectorCandidatesToExistingJpegs
} from '../lib/streaming/build12-streaming-session.js'

const WIDTH = 160
const HEIGHT = 90
const FRAME_BYTES = WIDTH * HEIGHT

function baseFrame(value = 70) {
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

function makeSelectorWith88Candidates() {
    const selector = new AdaptiveFrameSelector({ minSeparationMs: 1000 })
    const base = baseFrame()
    const middle = patch(base, 8, 18, 60, 54, 210)
    const late = patch(base, 92, 18, 60, 54, 210)

    for (let i = 0; i < 88; i++) {
        const elapsedMs = Math.round((i * 6000) / 87)
        const luma = i === 43 ? middle : i === 86 ? late : Buffer.from(base)
        selector.evaluate({
            clean: true,
            luma,
            elapsedMs,
            sourceIndex: i,
            pts: i * 4500,
            ptsTime: elapsedMs / 1000,
            observedAt: `2026-09-06T20:00:${String(Math.floor(elapsedMs / 1000)).padStart(2, '0')}.000Z`
        })
    }
    return selector
}

async function writeCandidateFiles(tempDir, { omit = new Set() } = {}) {
    for (let i = 0; i < 88; i++) {
        if (omit.has(i)) continue
        await writeFile(join(tempDir, candidateFilenameForSourceIndex(i)), Buffer.from(`jpeg-candidate-${String(i).padStart(6, '0')}`))
    }
}

test('88 candidates can select late frame #86 only when its physical JPEG exists and all selected JPEGs read successfully', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ki-burst-jpeg-'))
    try {
        const selector = makeSelectorWith88Candidates()
        await writeCandidateFiles(tempDir)

        const inventory = inspectCandidateJpegFiles(await readdir(tempDir), selector.candidates.map(candidate => candidate.sourceIndex))
        assert.equal(inventory.jpegCount, 88)
        assert.equal(inventory.minSourceIndex, 0)
        assert.equal(inventory.maxSourceIndex, 87)
        assert.equal(inventory.candidate000086Present, true)
        assert.deepEqual(inventory.missingMetadataSourceIndices, [])

        restrictSelectorCandidatesToExistingJpegs(selector, inventory.existingSourceIndices)
        const { selected } = selector.finalizeBuffered()
        assert.deepEqual(selected.map(candidate => candidate.sourceIndex), [0, 43, 86])

        const loaded = await loadSelectedCandidateJpegs(tempDir, selected)
        assert.equal(loaded.frames.length, 3)
        assert.equal(new Set(loaded.frameHashes).size, 3)
        assert.deepEqual(loaded.sourceIndices, [0, 43, 86])
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
})

test('missing physical JPEG is removed before final selection so selector cannot produce ENOENT', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ki-burst-jpeg-missing-'))
    try {
        const selector = makeSelectorWith88Candidates()
        await writeCandidateFiles(tempDir, { omit: new Set([86]) })

        const inventory = inspectCandidateJpegFiles(await readdir(tempDir), selector.candidates.map(candidate => candidate.sourceIndex))
        assert.equal(inventory.jpegCount, 87)
        assert.equal(inventory.minSourceIndex, 0)
        assert.equal(inventory.maxSourceIndex, 87)
        assert.equal(inventory.candidate000086Present, false)
        assert.deepEqual(inventory.missingMetadataSourceIndices, [86])

        const restriction = restrictSelectorCandidatesToExistingJpegs(selector, inventory.existingSourceIndices)
        assert.deepEqual(restriction.removedSourceIndices, [86])
        assert.equal(selector.candidates.some(candidate => candidate.sourceIndex === 86), false)

        const { selected } = selector.finalizeBuffered()
        assert.equal(selected.some(candidate => candidate.sourceIndex === 86), false)
        const loaded = await loadSelectedCandidateJpegs(tempDir, selected)
        assert.equal(loaded.frames.length, 3)
        assert.equal(new Set(loaded.frameHashes).size, 3)
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
})
