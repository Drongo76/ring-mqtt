import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { publishBurstState } from '../lib/build12-patch.js'

const BURST_ID = '1791868702083-5'

function makeCamera() {
    const publishes = []
    const debug = []
    return {
        data: {
            snapshot: { cache: Buffer.from('SNAP'), cacheType: 'motion', timestamp: 100, sourceTimestamp: 100000 },
            motion: { active_ding: true, last_ding: 100 },
            ki_burst: { status: 'capturing', burstId: BURST_ID, motionEventTimestamp: 100, frames: [null, null, null], attributes: {} }
        },
        entity: {
            ki_burst_frame_1: { topic: 'frame/1' },
            ki_burst_frame_2: { topic: 'frame/2' },
            ki_burst_frame_3: { topic: 'frame/3' },
            ki_burst_status: { state_topic: 'status', json_attributes_topic: 'status/attr' }
        },
        mqttPublish: (topic, payload) => publishes.push({ topic, payload }),
        debug: message => debug.push(String(message)),
        publishes,
        debugMessages: debug
    }
}

async function liveFrames(dir) {
    const paths = [1, 2, 3].map(index => join(dir, `frame-${index}.jpg`))
    await Promise.all(paths.map((path, index) => writeFile(path, Buffer.from(`W${index + 2}`))))
    return paths
}

function complete(paths) {
    return {
        burstId: BURST_ID,
        frames: [Buffer.from('W2'), Buffer.from('W3'), Buffer.from('W4')],
        paths,
        frameCount: 3,
        frameSourceIndices: [0, 14, 29],
        differenceScores: [0, 0.0235, 0.03],
        changedBlockRatios: [0, 0.1167, 0.2],
        selectionReasons: ['first_clean_frame', 'early_visual_change_primary', 'compatibility_tail'],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        minimumSelectionSeparationMs: 1000
    }
}

async function waitFor(check, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const value = await check()
        if (value) return value
        if (Date.now() > deadline) throw new Error('condition not reached in time')
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}

async function withEnv(values, run) {
    const before = {}
    for (const [key, value] of Object.entries(values)) {
        before[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        return await run()
    } finally {
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('a completed burst is archived with exactly the frames that were published', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-history-publish-'))
    try {
        await withEnv({ KI_BURST_HISTORY_DIR: undefined, KI_BURST_HISTORY_KEEP: undefined }, async () => {
            const camera = makeCamera()
            publishBurstState(camera, 'complete', complete(await liveFrames(dir)))
            assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'complete')

            const archived = join(dir, 'history', BURST_ID)
            await waitFor(() => readdir(archived).then(names => names.includes('meta.json'), () => false))

            // Frame 1 is the Motion Snapshot, 2 and 3 the selected WebRTC frames, as published over MQTT.
            for (const [index, expected] of ['SNAP', 'W2', 'W3'].entries()) {
                assert.equal((await readFile(join(archived, `frame-${index + 1}.jpg`))).toString(), expected)
                assert.equal(camera.publishes.find(entry => entry.topic === `frame/${index + 1}`).payload.toString(), expected)
            }
            const meta = JSON.parse(await readFile(join(archived, 'meta.json'), 'utf8'))
            assert.equal(meta.burstId, BURST_ID)
            assert.equal(meta.status, 'complete')
            assert.deepEqual(meta.changedBlockRatios, [null, 0, 0.1167])
            assert.ok(meta.savedAt)
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('a failing history never changes the published result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-history-publish-'))
    try {
        // The history directory is a regular file, so creating it inside must fail.
        const blocker = join(dir, 'not-a-directory')
        await writeFile(blocker, 'x')
        await withEnv({ KI_BURST_HISTORY_DIR: join(blocker, 'history'), KI_BURST_HISTORY_KEEP: undefined }, async () => {
            const camera = makeCamera()
            publishBurstState(camera, 'complete', complete(await liveFrames(dir)))

            assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'complete')
            assert.equal(camera.publishes.find(entry => entry.topic === 'frame/1').payload.toString(), 'SNAP')
            await waitFor(() => camera.debugMessages.some(message => message.includes('history archive failed')))
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('KI_BURST_HISTORY_KEEP=0 switches the history off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-history-publish-'))
    try {
        await withEnv({ KI_BURST_HISTORY_DIR: undefined, KI_BURST_HISTORY_KEEP: '0' }, async () => {
            const camera = makeCamera()
            publishBurstState(camera, 'complete', complete(await liveFrames(dir)))
            assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'complete')
            await new Promise(resolve => setTimeout(resolve, 150))
            assert.equal((await readdir(dir)).includes('history'), false)
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('a failed burst is not archived', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-history-publish-'))
    try {
        await withEnv({ KI_BURST_HISTORY_DIR: undefined, KI_BURST_HISTORY_KEEP: undefined }, async () => {
            const camera = makeCamera()
            publishBurstState(camera, 'failed', { burstId: BURST_ID, error: 'boom', paths: await liveFrames(dir) })
            await new Promise(resolve => setTimeout(resolve, 150))
            assert.equal((await readdir(dir)).includes('history'), false)
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
