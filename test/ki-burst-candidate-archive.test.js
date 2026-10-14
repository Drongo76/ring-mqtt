import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    pickCandidatesByStep,
    readKiBurstCandidateArchive,
    resolveKiBurstCandidatesKeep,
    resolveKiBurstCandidatesStepMs
} from '../lib/ki-burst-candidate-archive.js'
import { archiveKiBurst, CANDIDATES_DIR } from '../lib/ki-burst-history.js'

const filenameFor = index => `candidate-${String(index).padStart(6, '0')}.jpg`
const frames = [Buffer.from('f1'), Buffer.from('f2'), Buffer.from('f3')]

function candidates(count, everyMs = 70) {
    return Array.from({ length: count }, (_, i) => ({ sourceIndex: i, elapsedMs: i * everyMs, observedAt: `t${i}` }))
}

test('pickCandidatesByStep takes one candidate per step, in time order, starting with the first', () => {
    const picked = pickCandidatesByStep(candidates(100, 70), 500)
    assert.equal(picked[0].elapsedMs, 0)
    for (let i = 1; i < picked.length; i++) {
        assert.ok(picked[i].elapsedMs - picked[i - 1].elapsedMs >= 430)
        assert.ok(picked[i].elapsedMs > picked[i - 1].elapsedMs)
    }
    assert.ok(picked.length >= 13 && picked.length <= 15)
})

test('pickCandidatesByStep ignores invalid entries and unsorted input', () => {
    const picked = pickCandidatesByStep([
        { sourceIndex: 3, elapsedMs: 1200 }, null, { sourceIndex: 'x', elapsedMs: 5 },
        { sourceIndex: 1, elapsedMs: 0 }, { sourceIndex: 2, elapsedMs: 600 }, { sourceIndex: 4, elapsedMs: NaN }
    ], 500)
    assert.deepEqual(picked.map(c => c.sourceIndex), [1, 2, 3])
    assert.deepEqual(pickCandidatesByStep(undefined), [])
})

test('settings: defaults, off switch and invalid values', () => {
    assert.equal(resolveKiBurstCandidatesKeep({}), 10)
    assert.equal(resolveKiBurstCandidatesKeep({ KI_BURST_CANDIDATES_KEEP: '0' }), 0)
    assert.equal(resolveKiBurstCandidatesKeep({ KI_BURST_CANDIDATES_KEEP: '3' }), 3)
    assert.equal(resolveKiBurstCandidatesKeep({ KI_BURST_CANDIDATES_KEEP: 'abc' }), 10)
    assert.equal(resolveKiBurstCandidatesStepMs({}), 500)
    assert.equal(resolveKiBurstCandidatesStepMs({ KI_BURST_CANDIDATES_STEP_MS: '250' }), 250)
    assert.equal(resolveKiBurstCandidatesStepMs({ KI_BURST_CANDIDATES_STEP_MS: '5' }), 500)
})

test('readKiBurstCandidateArchive reads the sample, skips missing files and never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-cand-'))
    try {
        const all = candidates(30, 100)
        for (const c of all) if (c.sourceIndex !== 10) await writeFile(join(dir, filenameFor(c.sourceIndex)), Buffer.from(`jpeg${c.sourceIndex}`))
        const result = await readKiBurstCandidateArchive({ tempDir: dir, candidates: all, filenameForSourceIndex: filenameFor, env: {}, join })
        assert.ok(result.length >= 5)
        assert.ok(result.every(entry => entry.jpeg.toString() === `jpeg${entry.sourceIndex}`))
        assert.ok(!result.some(entry => entry.sourceIndex === 10))
        assert.deepEqual(await readKiBurstCandidateArchive({ tempDir: dir, candidates: all, filenameForSourceIndex: filenameFor, env: { KI_BURST_CANDIDATES_KEEP: '0' }, join }), [])
        assert.deepEqual(await readKiBurstCandidateArchive({ tempDir: join(dir, 'missing'), candidates: all, filenameForSourceIndex: filenameFor, env: {}, join }), [])
        assert.deepEqual(await readKiBurstCandidateArchive({ tempDir: dir, candidates: all, filenameForSourceIndex: () => { throw new Error('boom') }, env: {}, join }), [])
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('archiveKiBurst stores the candidate sample with an index and keeps it only for the newest bursts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-hist-'))
    try {
        const sample = id => [0, 500, 1000].map((elapsedMs, i) => ({ elapsedMs, sourceIndex: i * 7, observedAt: `${id}-${i}`, jpeg: Buffer.from(`${id}-${elapsedMs}`) }))
        for (let seq = 1; seq <= 4; seq++) {
            await archiveKiBurst({ historyDir: dir, burstId: `1791900000000-${seq}`, frames, attributes: { burstId: seq }, keep: 50, candidates: sample(seq), candidatesKeep: 2 })
        }
        const withCandidates = []
        for (const name of (await readdir(dir)).sort()) {
            const files = await readdir(join(dir, name))
            assert.ok(files.includes('frame-1.jpg') && files.includes('meta.json'), `${name} keeps its frames`)
            if (files.includes(CANDIDATES_DIR)) withCandidates.push(name)
        }
        assert.deepEqual(withCandidates, ['1791900000000-3', '1791900000000-4'])
        const index = JSON.parse(await readFile(join(dir, '1791900000000-4', CANDIDATES_DIR, 'index.json'), 'utf8'))
        assert.deepEqual(index.map(entry => entry.elapsedMs), [0, 500, 1000])
        assert.equal((await readFile(join(dir, '1791900000000-4', CANDIDATES_DIR, index[1].file))).toString(), '4-500')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('archiveKiBurst without candidates or with the switch off behaves as before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-hist-'))
    try {
        await archiveKiBurst({ historyDir: dir, burstId: '1791900000000-1', frames, attributes: {} })
        await archiveKiBurst({ historyDir: dir, burstId: '1791900000000-2', frames, attributes: {}, candidates: [{ elapsedMs: 0, sourceIndex: 0, jpeg: Buffer.from('x') }], candidatesKeep: 0 })
        for (const name of await readdir(dir)) {
            assert.ok(!(await readdir(join(dir, name))).includes(CANDIDATES_DIR))
        }
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
