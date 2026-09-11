import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import Camera from '../devices/camera.js'
import { publishBurstState } from '../lib/build12-patch.js'

function makeSnapshot(contents, timeMillis) {
    const snapshot = Buffer.from(contents)
    snapshot.timeMillis = timeMillis
    return snapshot
}

function makeCamera(responses = []) {
    const publishes = []
    const requestOptions = []
    const camera = Object.create(Camera.prototype)
    camera.availabilityState = 'online'
    camera.isOnline = () => camera.availabilityState === 'online'
    camera.snapshotRefreshGeneration = 0
    camera.debugMessages = []
    camera.debug = message => camera.debugMessages.push(String(message))
    camera.data = {
        snapshot: {
            interval: true,
            motion: true,
            ding: false,
            intervalDuration: 30,
            intervalTimerId: null,
            cache: makeSnapshot('initial', 100),
            cacheType: 'interval',
            timestamp: 1,
            sourceTimestamp: 100,
            onDemandTimestamp: 0
        },
        motion: {
            active_ding: false,
            last_ding: 100
        },
        ki_burst: {
            status: 'capturing',
            burstId: 'burst-28',
            motionEventTimestamp: 100,
            frames: [null, null, null],
            attributes: {}
        }
    }
    camera.entity = {
        snapshot: {
            topic: 'snapshot/image',
            json_attributes_topic: 'snapshot/attributes'
        },
        ki_burst_frame_1: { topic: 'ki/frame/1' },
        ki_burst_frame_2: { topic: 'ki/frame/2' },
        ki_burst_frame_3: { topic: 'ki/frame/3' },
        ki_burst_status: {
            state_topic: 'ki/status',
            json_attributes_topic: 'ki/status/attributes'
        }
    }
    camera.mqttPublish = (topic, payload) => publishes.push({ topic, payload })
    camera.device = {
        snapshotsAreBlocked: false,
        operatingOnBattery: false,
        getNextSnapshot: async options => {
            requestOptions.push(options)
            const response = responses.shift()
            return typeof response === 'function' ? response(options) : response
        }
    }
    camera.publishes = publishes
    camera.requestOptions = requestOptions
    return camera
}

function captureIntervalScheduler(camera) {
    const originalSetInterval = globalThis.setInterval
    let callback
    let delayMs
    globalThis.setInterval = (fn, ms) => {
        callback = fn
        delayMs = ms
        return { build28FakeTimer: true }
    }
    try {
        camera.scheduleSnapshotRefresh()
    } finally {
        globalThis.setInterval = originalSetInterval
    }
    return { callback, delayMs }
}

async function waitFor(predicate, message) {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return
        await new Promise(resolve => setImmediate(resolve))
    }
    assert.fail(message)
}

function snapshotAttributePublishes(camera) {
    return camera.publishes
        .filter(entry => entry.topic === 'snapshot/attributes')
        .map(entry => JSON.parse(entry.payload))
}

function snapshotImagePublishes(camera) {
    return camera.publishes.filter(entry => entry.topic === 'snapshot/image')
}

test('interval refresh keeps the existing 30 second scheduler and build27/build12 generation guard', async () => {
    const camera = makeCamera([makeSnapshot('interval-fresh-1', 101)])
    const { callback, delayMs } = captureIntervalScheduler(camera)

    assert.equal(delayMs, 30000)
    callback()
    await waitFor(() => snapshotAttributePublishes(camera).length === 1, 'interval snapshot was not published')

    assert.deepEqual(camera.requestOptions, [{ force: true }])
    assert.equal(camera.data.snapshot.cache.toString(), 'interval-fresh-1')
    assert.equal(camera.data.snapshot.sourceTimestamp, 101)
    assert.equal(camera.data.snapshot.cacheType, 'interval')
    assert.equal(snapshotImagePublishes(camera)[0].payload.toString(), 'interval-fresh-1')
    assert.equal(camera.snapshotRefreshGeneration, 1, 'interval must participate in the same generation guard as build27/build12')
})

test('consecutive interval cycles each advance generation and publish fresh results', async () => {
    const camera = makeCamera([
        makeSnapshot('interval-cycle-1', 101),
        makeSnapshot('interval-cycle-2', 102),
        makeSnapshot('interval-cycle-3', 103)
    ])
    const { callback } = captureIntervalScheduler(camera)
    const originalNow = Date.now
    let now = 100000
    Date.now = () => now
    try {
        for (let cycle = 1; cycle <= 3; cycle++) {
            callback()
            await waitFor(() => snapshotAttributePublishes(camera).length === cycle, `interval cycle ${cycle} was not published`)
            now += 1000
        }
    } finally {
        Date.now = originalNow
    }

    assert.deepEqual(camera.requestOptions, [{ force: true }, { force: true }, { force: true }])
    assert.deepEqual(snapshotImagePublishes(camera).map(entry => entry.payload.toString()), [
        'interval-cycle-1',
        'interval-cycle-2',
        'interval-cycle-3'
    ])
    assert.equal(camera.snapshotRefreshGeneration, 3)
})

test('overlapping interval refreshes use build27/build12 supersession: older result cannot overwrite newer request', async () => {
    let resolveFirst
    let resolveSecond
    const firstResponse = new Promise(resolve => { resolveFirst = resolve })
    const secondResponse = new Promise(resolve => { resolveSecond = resolve })
    const camera = makeCamera([
        () => firstResponse,
        () => secondResponse
    ])
    const { callback } = captureIntervalScheduler(camera)

    callback()
    await waitFor(() => camera.requestOptions.length === 1, 'first interval request did not start')
    callback()
    await waitFor(() => camera.requestOptions.length === 2, 'second interval request did not start')
    assert.equal(camera.snapshotRefreshGeneration, 2)

    resolveFirst(makeSnapshot('slow-interval-cycle-1', 101))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(snapshotAttributePublishes(camera).length, 0, 'superseded first interval result must be discarded')

    resolveSecond(makeSnapshot('slow-interval-cycle-2', 102))
    await waitFor(() => snapshotAttributePublishes(camera).length === 1, 'newest interval result was not published')

    assert.deepEqual(snapshotImagePublishes(camera).map(entry => entry.payload.toString()), ['slow-interval-cycle-2'])
    assert.equal(camera.data.snapshot.cache.toString(), 'slow-interval-cycle-2')
    assert.ok(camera.debugMessages.some(message => message.includes('Discarding superseded interval')))
})

test('Motion refresh still uses the same generation protection', async () => {
    const camera = makeCamera([makeSnapshot('motion-fresh', 200)])

    const result = await camera.refreshSnapshot('motion', 'motion-uuid-28')

    assert.equal(result, true)
    assert.deepEqual(camera.requestOptions[0], { uuid: 'motion-uuid-28' })
    assert.equal(camera.data.snapshot.cache.toString(), 'motion-fresh')
    assert.equal(camera.data.snapshot.cacheType, 'motion')
    assert.equal(camera.snapshotRefreshGeneration, 1)
})

test('interval refresh after Motion advances the same shared generation', async () => {
    const camera = makeCamera([
        makeSnapshot('motion-first', 200),
        makeSnapshot('interval-after-motion', 201)
    ])
    const { callback } = captureIntervalScheduler(camera)

    camera.data.motion.active_ding = true
    assert.equal(await camera.refreshSnapshot('motion', 'motion-uuid-28'), true)
    assert.equal(camera.snapshotRefreshGeneration, 1)

    camera.data.motion.active_ding = false
    callback()
    await waitFor(() => snapshotAttributePublishes(camera).length === 2, 'interval refresh did not resume after Motion')

    assert.equal(camera.data.snapshot.cache.toString(), 'interval-after-motion')
    assert.equal(camera.data.snapshot.cacheType, 'interval')
    assert.equal(camera.snapshotRefreshGeneration, 2)
})

test('distinct on-demand behavior remains unchanged', async () => {
    const camera = makeCamera([
        makeSnapshot('initial', 100),
        makeSnapshot('on-demand-fresh', 101)
    ])

    const result = await camera.refreshSnapshot('on-demand')

    assert.equal(result, true)
    assert.equal(camera.requestOptions.length, 2)
    assert.deepEqual(camera.requestOptions[0], { afterMs: 100, maxWaitMs: 3000, force: true })
    assert.deepEqual(camera.requestOptions[1], { afterMs: 100, maxWaitMs: 3000, force: true })
    assert.equal(camera.data.snapshot.cache.toString(), 'on-demand-fresh')
    assert.equal(camera.data.snapshot.cacheType, 'on-demand')
    assert.equal(camera.snapshotRefreshGeneration, 1)
})

test('delayed on-demand cannot overwrite newer Motion', async () => {
    let resolveOnDemand
    const camera = makeCamera([])
    camera.device.getNextSnapshot = options => {
        camera.requestOptions.push(options)
        if (options.afterMs) return new Promise(resolve => { resolveOnDemand = resolve })
        return Promise.resolve(makeSnapshot('new-motion', 200))
    }

    const delayedOnDemand = camera.refreshSnapshot('on-demand')
    await new Promise(resolve => setImmediate(resolve))
    const motionResult = await camera.refreshSnapshot('motion', 'motion-uuid-generation-28')
    resolveOnDemand(makeSnapshot('late-on-demand', 201))
    const onDemandResult = await delayedOnDemand

    assert.equal(motionResult, true)
    assert.equal(onDemandResult, false)
    assert.equal(camera.data.snapshot.cache.toString(), 'new-motion')
    assert.equal(camera.data.snapshot.cacheType, 'motion')
    assert.equal(camera.snapshotRefreshGeneration, 2)
    assert.ok(camera.debugMessages.some(message => message.includes('Discarding superseded on-demand')))
})

test('KI Burst keeps Motion Snapshot as final F1 and publishes first clean / early adaptive WebRTC as F2/F3 without another snapshot request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-build28-'))
    try {
        const paths = [join(dir, 'frame-1.jpg'), join(dir, 'frame-2.jpg'), join(dir, 'frame-3.jpg')]
        await writeFile(paths[0], Buffer.from('SELECTED_A'))
        await writeFile(paths[1], Buffer.from('SELECTED_B'))
        await writeFile(paths[2], Buffer.from('SELECTED_C'))

        const camera = makeCamera([makeSnapshot('MOTION_SNAPSHOT_FOR_BURST', 200)])
        const originalNow = Date.now
        Date.now = () => 200000
        try {
            camera.data.motion.last_ding = 100
            camera.data.ki_burst.motionEventTimestamp = 100
            assert.equal(await camera.refreshSnapshot('motion', 'motion-uuid-burst-28'), true)
        } finally {
            Date.now = originalNow
        }

        assert.equal(camera.requestOptions.length, 1)
        const motionSnapshotBytes = Buffer.from(camera.data.snapshot.cache)

        publishBurstState(camera, 'complete', {
            burstId: 'burst-28',
            frames: [Buffer.from('SELECTED_A'), Buffer.from('SELECTED_B'), Buffer.from('SELECTED_C')],
            paths,
            frameCount: 3,
            intervalMs: 1000,
            capturedAt: '2026-09-10T11:00:00.000Z',
            frameOffsetsMs: [0, 1100, 2200],
            actualFrameOffsetsMs: [0, 1100, 2200],
            selectionMode: 'adaptive_buffered',
            observationWindowMs: 6000,
            minimumSelectionSeparationMs: 1000,
            frameSourceIndices: [0, 20, 40],
            frameHashes: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
            rtpIntegrity: {}
        })

        assert.equal(camera.requestOptions.length, 1, 'KI Burst must not make a second Ring snapshot request')
        assert.equal(camera.data.ki_burst.status, 'complete')
        assert.deepEqual(camera.data.ki_burst.frames[0], motionSnapshotBytes)
        assert.equal(camera.data.ki_burst.frames[0].toString(), 'MOTION_SNAPSHOT_FOR_BURST')
        assert.equal(camera.data.ki_burst.frames[1].toString(), 'SELECTED_A')
        assert.equal(camera.data.ki_burst.frames[2].toString(), 'SELECTED_B')
        assert.equal(camera.data.snapshot.cache.toString(), 'MOTION_SNAPSHOT_FOR_BURST')
        assert.equal(camera.data.snapshot.cacheType, 'motion')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
