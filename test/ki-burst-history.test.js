import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
    KI_BURST_HISTORY_MAX,
    archiveKiBurst,
    listKiBurstHistory,
    parseKiBurstId,
    pruneKiBurstHistory,
    resolveKiBurstHistoryDir,
    resolveKiBurstHistoryKeep
} from '../lib/ki-burst-history.js'

async function withDir(run) {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-history-'))
    try {
        return await run(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

const frames = label => [1, 2, 3].map(index => Buffer.from(`${label}-frame-${index}`))

test('history directory: explicit setting wins, otherwise next to the live frames, otherwise none', () => {
    assert.equal(resolveKiBurstHistoryDir({ env: { KI_BURST_HISTORY_DIR: ' /share/ki ' }, framePaths: ['/data/ki-burst/1/frame-1.jpg'] }), '/share/ki')
    assert.equal(resolveKiBurstHistoryDir({ env: {}, framePaths: ['/data/ki-burst/43714099/frame-1.jpg'] }), '/data/ki-burst/43714099/history')
    assert.equal(resolveKiBurstHistoryDir({ env: {}, framePaths: [] }), null)
    assert.equal(resolveKiBurstHistoryDir({ env: {}, framePaths: undefined }), null)
})

test('history size: default 50, explicit number, 0 switches it off, garbage falls back to default', () => {
    assert.equal(KI_BURST_HISTORY_MAX, 50)
    assert.equal(resolveKiBurstHistoryKeep({}), 50)
    assert.equal(resolveKiBurstHistoryKeep({ KI_BURST_HISTORY_KEEP: '120' }), 120)
    assert.equal(resolveKiBurstHistoryKeep({ KI_BURST_HISTORY_KEEP: '0' }), 0)
    assert.equal(resolveKiBurstHistoryKeep({ KI_BURST_HISTORY_KEEP: '-3' }), 50)
    assert.equal(resolveKiBurstHistoryKeep({ KI_BURST_HISTORY_KEEP: 'abc' }), 50)
    assert.equal(resolveKiBurstHistoryKeep({ KI_BURST_HISTORY_KEEP: '' }), 50)
})

test('only real burst ids are accepted', () => {
    assert.deepEqual(parseKiBurstId('1791868702083-5'), { timestamp: 1791868702083, sequence: 5 })
    for (const bad of ['../etc', '1791868702083', 'burst-25', '1791868702083-5/../x', '', null, undefined, '.tmp-1791868702083-5']) {
        assert.equal(parseKiBurstId(bad), null, `${bad} must be refused`)
    }
})

test('archive stores the three frames and the status attributes, readable at once', async () => {
    await withDir(async dir => {
        const attributes = { status: 'complete', burstId: '1791868702083-5', differenceScores: [null, 0, 0.0235] }
        const { path } = await archiveKiBurst({
            historyDir: dir,
            burstId: '1791868702083-5',
            frames: frames('a'),
            attributes,
            now: () => new Date('2026-10-13T05:18:30.000Z')
        })
        assert.equal(path, join(dir, '1791868702083-5'))
        assert.deepEqual((await readdir(path)).sort(), ['frame-1.jpg', 'frame-2.jpg', 'frame-3.jpg', 'meta.json'])
        assert.equal((await readFile(join(path, 'frame-2.jpg'))).toString(), 'a-frame-2')
        const meta = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8'))
        assert.equal(meta.savedAt, '2026-10-13T05:18:30.000Z')
        assert.deepEqual(meta.differenceScores, [null, 0, 0.0235])
        assert.deepEqual(await readdir(dir), ['1791868702083-5'], 'no temporary directory may be left behind')
    })
})

test('only the newest N bursts stay; order is numeric, not alphabetical', async () => {
    await withDir(async dir => {
        // Alphabetically "…-10" sorts before "…-5", numerically it is newer.
        const ids = ['1791868702083-5', '1791868702083-10', '1791868702083-9', '1791868700000-99', '1791868709999-1']
        for (const id of ids) await archiveKiBurst({ historyDir: dir, burstId: id, frames: frames(id), keep: 100 })

        const result = await archiveKiBurst({ historyDir: dir, burstId: '1791868712345-2', frames: frames('new'), keep: 3 })
        assert.deepEqual(await listKiBurstHistory(dir), ['1791868712345-2', '1791868709999-1', '1791868702083-10'])
        assert.deepEqual(result.pruned.sort(), ['1791868700000-99', '1791868702083-5', '1791868702083-9'].sort())
    })
})

test('pruning never touches files or folders that are not bursts', async () => {
    await withDir(async dir => {
        await writeFile(join(dir, 'notes.txt'), 'keep me')
        await mkdir(join(dir, 'my-own-folder'))
        for (const id of ['1791868700001-1', '1791868700002-1', '1791868700003-1']) {
            await archiveKiBurst({ historyDir: dir, burstId: id, frames: frames(id), keep: 100 })
        }
        await pruneKiBurstHistory(dir, 1)
        assert.deepEqual((await readdir(dir)).sort(), ['1791868700003-1', 'my-own-folder', 'notes.txt'])
    })
})

test('re-archiving the same burst replaces it instead of failing or mixing frames', async () => {
    await withDir(async dir => {
        await archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: frames('old'), attributes: { v: 1 } })
        await archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: frames('new'), attributes: { v: 2 } })
        assert.equal((await readFile(join(dir, '1791868702083-5', 'frame-3.jpg'))).toString(), 'new-frame-3')
        assert.equal(JSON.parse(await readFile(join(dir, '1791868702083-5', 'meta.json'), 'utf8')).v, 2)
        assert.deepEqual(await readdir(dir), ['1791868702083-5'])
    })
})

test('unsafe ids and missing data are refused before anything is written', async () => {
    await withDir(async dir => {
        await assert.rejects(archiveKiBurst({ historyDir: dir, burstId: '../escape', frames: frames('x') }), /unexpected burst id/)
        await assert.rejects(archiveKiBurst({ historyDir: dir, burstId: 'burst-25', frames: frames('x') }), /unexpected burst id/)
        await assert.rejects(archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: [] }), /non-empty frames/)
        await assert.rejects(archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: [Buffer.alloc(0), Buffer.from('a'), Buffer.from('b')] }), /non-empty frames/)
        await assert.rejects(archiveKiBurst({ historyDir: null, burstId: '1791868702083-5', frames: frames('x') }), /not configured/)
        assert.deepEqual(await readdir(dir), [])
    })
})

test('a failed write leaves the previous archive and no temporary folder', async () => {
    await withDir(async dir => {
        await archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: frames('good') })
        // A frame that is not binary data makes writeFile throw halfway through the archive.
        await assert.rejects(archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: [Buffer.from('a'), { not: 'binary' }, Buffer.from('c')] }))
        assert.deepEqual(await readdir(dir), ['1791868702083-5'])
        assert.equal((await readFile(join(dir, '1791868702083-5', 'frame-1.jpg'))).toString(), 'good-frame-1')
    })
})

test('a temporary folder left by a crash is cleaned up once it is old, a fresh one is not touched', async () => {
    await withDir(async dir => {
        const stale = join(dir, '.tmp-1791868700000-1-111-aaa')
        const fresh = join(dir, '.tmp-1791868700000-2-222-bbb')
        await mkdir(stale)
        await mkdir(fresh)
        const old = new Date(Date.now() - 60 * 60 * 1000)
        await utimes(stale, old, old)

        await archiveKiBurst({ historyDir: dir, burstId: '1791868702083-5', frames: frames('x') })
        assert.deepEqual((await readdir(dir)).sort(), ['.tmp-1791868700000-2-222-bbb', '1791868702083-5'])
    })
})

test('bursts archived at the same time all arrive complete and the limit still holds', async () => {
    await withDir(async dir => {
        const ids = Array.from({ length: 8 }, (_, index) => `${1791868700000 + index}-${index + 1}`)
        await Promise.all(ids.map(id => archiveKiBurst({ historyDir: dir, burstId: id, frames: frames(id), keep: 5 })))
        const kept = await listKiBurstHistory(dir)
        assert.equal(kept.length, 5)
        for (const id of kept) {
            assert.deepEqual((await readdir(join(dir, id))).sort(), ['frame-1.jpg', 'frame-2.jpg', 'frame-3.jpg', 'meta.json'])
            assert.equal((await readFile(join(dir, id, 'frame-1.jpg'))).toString(), `${id}-frame-1`)
        }
        assert.equal((await readdir(dir)).some(name => name.startsWith('.tmp-')), false)
    })
})

test('a history folder that does not exist yet reads as empty', async () => {
    await withDir(async dir => {
        assert.deepEqual(await listKiBurstHistory(join(dir, 'missing')), [])
    })
})
