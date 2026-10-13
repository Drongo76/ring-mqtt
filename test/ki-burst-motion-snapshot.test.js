import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import Camera from '../devices/camera.js'
import { publishBurstState } from '../lib/build12-patch.js'
import { rememberMotionSnapshot, selectBurstSnapshot } from '../lib/ki-burst-motion-snapshot.js'

const BURST_ID = '1791893439739-6'
const MOTION = 1000
const OTHER_MOTION = 2000

function snapshotImage(contents, timeMillis) {
    const image = Buffer.from(contents)
    image.timeMillis = timeMillis
    return image
}

// ---------------------------------------------------------------- the slot itself

test('the Motion Snapshot slot keeps the image of its own Motion event', () => {
    const state = { cache: Buffer.from('ding'), cacheType: 'ding', timestamp: 1010, sourceTimestamp: 5 }
    rememberMotionSnapshot(state, { image: Buffer.from('motion'), motionTimestamp: MOTION, capturedAt: 1001, sourceTimestamp: 999900 })

    const chosen = selectBurstSnapshot(state, MOTION)
    assert.equal(chosen.snapshot.toString(), 'motion')
    assert.equal(chosen.snapshotType, 'motion')
    assert.equal(chosen.snapshotTimestamp, 1001)
    assert.equal(chosen.sourceTimestamp, 999900)
})

test('a Motion Snapshot of an older Motion event is never used for a newer burst', () => {
    const state = { cache: Buffer.from('ding'), cacheType: 'ding', timestamp: 2010, sourceTimestamp: 5 }
    rememberMotionSnapshot(state, { image: Buffer.from('old motion'), motionTimestamp: MOTION, capturedAt: 1001 })

    const chosen = selectBurstSnapshot(state, OTHER_MOTION)
    assert.equal(chosen.snapshot.toString(), 'ding', 'falls back to the shared cache, whose own checks then refuse it')
    assert.equal(chosen.snapshotType, 'ding')
})

test('without a Motion Snapshot slot the shared cache is returned unchanged', () => {
    const state = { cache: Buffer.from('shared'), cacheType: 'motion', timestamp: 1001, sourceTimestamp: 7 }
    const chosen = selectBurstSnapshot(state, MOTION)
    assert.equal(chosen.snapshot.toString(), 'shared')
    assert.equal(chosen.snapshotType, 'motion')
    assert.equal(chosen.snapshotTimestamp, 1001)
    assert.equal(chosen.sourceTimestamp, 7)
    assert.equal(selectBurstSnapshot(undefined, MOTION).snapshot, undefined)
})

test('the slot refuses data that cannot be a Motion Snapshot', () => {
    assert.throws(() => rememberMotionSnapshot(undefined, { image: Buffer.from('x') }), TypeError)
    assert.throws(() => rememberMotionSnapshot({}, { image: Buffer.alloc(0), motionTimestamp: MOTION }), TypeError)
    assert.throws(() => rememberMotionSnapshot({}, { image: 'not a buffer', motionTimestamp: MOTION }), TypeError)
})

// ---------------------------------------------------------------- how the camera fills it

function makeSnapshotCamera({ lastDing = MOTION } = {}) {
    const camera = Object.create(Camera.prototype)
    camera.data = {
        motion: { last_ding: lastDing },
        snapshot: { cache: null, cacheType: null, timestamp: null, sourceTimestamp: null }
    }
    camera.snapshotRefreshGeneration = 0
    camera.debug = () => {}
    camera.publishSnapshot = () => {}
    camera.responses = []
    camera.device = {
        snapshotsAreBlocked: false,
        operatingOnBattery: false,
        getNextSnapshot: async () => {
            const next = camera.responses.shift()
            return typeof next === 'function' ? next() : next
        }
    }
    return camera
}

test('a later Ding or interval snapshot replaces the shared cache but not the Motion Snapshot', async () => {
    const camera = makeSnapshotCamera()

    camera.responses.push(snapshotImage('motion image', 1000500))
    assert.equal(await camera.refreshSnapshot('motion', 'uuid-1'), true)

    camera.responses.push(snapshotImage('ding image', 1006000))
    assert.equal(await camera.refreshSnapshot('ding', 'uuid-2'), true)
    camera.responses.push(snapshotImage('interval image', 1030000))
    assert.equal(await camera.refreshSnapshot('interval'), true)

    assert.equal(camera.data.snapshot.cache.toString(), 'interval image')
    assert.equal(camera.data.snapshot.cacheType, 'interval')

    const chosen = selectBurstSnapshot(camera.data.snapshot, MOTION)
    assert.equal(chosen.snapshot.toString(), 'motion image')
    assert.equal(chosen.snapshotType, 'motion')
    assert.equal(chosen.sourceTimestamp, 1000500)
})

test('the Motion Snapshot is bound to the Motion event that requested it, not to a newer last_ding', async () => {
    const camera = makeSnapshotCamera({ lastDing: MOTION })

    camera.responses.push(() => {
        // A newer Motion push moves last_ding on while the image of the first one is still on its way.
        camera.data.motion.last_ding = OTHER_MOTION
        return snapshotImage('first motion image', 1000500)
    })
    await camera.refreshSnapshot('motion', 'uuid-1')

    assert.equal(camera.data.snapshot.motionCapture.motionTimestamp, MOTION)
    assert.equal(selectBurstSnapshot(camera.data.snapshot, MOTION).snapshot.toString(), 'first motion image')
    assert.equal(selectBurstSnapshot(camera.data.snapshot, OTHER_MOTION).snapshotType, 'motion', 'shared cache fallback still carries the motion type')
    assert.notEqual(selectBurstSnapshot(camera.data.snapshot, OTHER_MOTION).snapshot.toString(), 'x')
})

test('a Ding that arrives while the Motion Snapshot is still on its way does not lose it', async () => {
    const camera = makeSnapshotCamera()

    let finishMotion
    camera.responses.push(() => new Promise(resolve => { finishMotion = () => resolve(snapshotImage('late motion image', 1000900)) }))
    const motionRefresh = camera.refreshSnapshot('motion', 'uuid-1')
    await new Promise(resolve => setImmediate(resolve))

    camera.responses.push(snapshotImage('ding image', 1002000))
    assert.equal(await camera.refreshSnapshot('ding', 'uuid-2'), true)

    finishMotion()
    assert.equal(await motionRefresh, false, 'the superseded request still must not overwrite the published snapshot')
    assert.equal(camera.data.snapshot.cache.toString(), 'ding image')
    assert.equal(selectBurstSnapshot(camera.data.snapshot, MOTION).snapshot.toString(), 'late motion image')
})

test('snapshots that are not Motion Snapshots never create the slot', async () => {
    const camera = makeSnapshotCamera()
    camera.responses.push(snapshotImage('ding image', 1002000))
    await camera.refreshSnapshot('ding', 'uuid-2')
    camera.responses.push(snapshotImage('interval image', 1030000))
    await camera.refreshSnapshot('interval')
    assert.equal(camera.data.snapshot.motionCapture, undefined)
})

// ---------------------------------------------------------------- the burst that was lost on 2026-10-13

function makeBurstCamera(snapshotState) {
    const publishes = []
    const debug = []
    return {
        data: {
            snapshot: snapshotState,
            motion: { active_ding: true, last_ding: MOTION },
            ki_burst: { status: 'capturing', burstId: BURST_ID, motionEventTimestamp: MOTION, frames: [null, null, null], attributes: {} }
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

async function withBurstFiles(run) {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-motion-snapshot-'))
    const before = process.env.KI_BURST_HISTORY_KEEP
    process.env.KI_BURST_HISTORY_KEEP = '0'
    try {
        const paths = [1, 2, 3].map(index => join(dir, `frame-${index}.jpg`))
        await Promise.all(paths.map((path, index) => writeFile(path, Buffer.from(`W${index + 1}`))))
        return await run(paths)
    } finally {
        if (before === undefined) delete process.env.KI_BURST_HISTORY_KEEP
        else process.env.KI_BURST_HISTORY_KEEP = before
        await rm(dir, { recursive: true, force: true })
    }
}

function completeDetails(paths) {
    return {
        burstId: BURST_ID,
        frames: [Buffer.from('WA'), Buffer.from('WB'), Buffer.from('WC')],
        paths,
        frameCount: 3,
        frameSourceIndices: [0, 14, 29],
        differenceScores: [0, 0.01, 0.02],
        changedBlockRatios: [0, 0.03, 0.05],
        selectionReasons: ['first_clean_frame', 'early_low_diversity_fallback', 'compatibility_tail'],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        minimumSelectionSeparationMs: 1000
    }
}

test('Motion, then a doorbell press during the burst: the burst completes with the Motion Snapshot as Frame 1', async () => {
    await withBurstFiles(async paths => {
        // State as it was at 14:10:47 on 2026-10-13: the shared cache holds the Ding snapshot.
        const snapshotState = { cache: snapshotImage('DING', 1006000), cacheType: 'ding', timestamp: 1006, sourceTimestamp: 1006000 }
        rememberMotionSnapshot(snapshotState, { image: Buffer.from('MOTION'), motionTimestamp: MOTION, capturedAt: 1001, sourceTimestamp: 1000500 })
        const camera = makeBurstCamera(snapshotState)

        publishBurstState(camera, 'complete', completeDetails(paths))

        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'complete')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/1').payload.toString(), 'MOTION')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/2').payload.toString(), 'WA')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/3').payload.toString(), 'WB')
        const attributes = JSON.parse(camera.publishes.find(entry => entry.topic === 'status/attr').payload)
        assert.equal(attributes.snapshotSourceTimestamp, 1000500)
        assert.equal(attributes.snapshotCapturedAt, new Date(1001 * 1000).toISOString())
        assert.deepEqual(attributes.outputFrameSources, ['motion_snapshot', 'adaptive_selected_2', 'adaptive_selected_3'])
    })
})

test('without any Motion Snapshot of this event a Ding snapshot is still refused as Frame 1', async () => {
    await withBurstFiles(async paths => {
        const camera = makeBurstCamera({ cache: snapshotImage('DING', 1006000), cacheType: 'ding', timestamp: 1006, sourceTimestamp: 1006000 })

        publishBurstState(camera, 'complete', completeDetails(paths))

        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'failed')
        assert.equal(camera.publishes.some(entry => entry.topic === 'frame/1'), false)
        const attributes = JSON.parse(camera.publishes.find(entry => entry.topic === 'status/attr').payload)
        assert.match(attributes.error, /requires Motion Snapshot, current snapshot type is ding/)
    })
})

test('a Motion Snapshot of an earlier Motion event does not rescue a burst of a newer one', async () => {
    await withBurstFiles(async paths => {
        const snapshotState = { cache: snapshotImage('DING', 2006000), cacheType: 'ding', timestamp: 2006, sourceTimestamp: 2006000 }
        rememberMotionSnapshot(snapshotState, { image: Buffer.from('OLD MOTION'), motionTimestamp: 500, capturedAt: 501 })
        const camera = makeBurstCamera(snapshotState)
        camera.data.ki_burst.motionEventTimestamp = OTHER_MOTION
        camera.data.motion.last_ding = OTHER_MOTION

        publishBurstState(camera, 'complete', completeDetails(paths))

        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'failed')
        assert.equal(camera.publishes.some(entry => entry.topic === 'frame/1'), false)
    })
})
