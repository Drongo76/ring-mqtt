import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { composeKiBurstFrames } from '../lib/ki-burst-output.js'
import { publishBurstState } from '../lib/build12-patch.js'
import {
    KiBurstController,
    KI_BURST_CONTROLLER_TIMEOUT_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from '../lib/ki-burst-controller.js'

function makeCamera({ snapshot = Buffer.from('HASH_S'), snapshotTimestamp = 100, motionTimestamp = 100 } = {}) {
    let snapshotRequests = 0
    const publishes = []
    const debug = []
    return {
        data: {
            snapshot: {
                cache: snapshot,
                cacheType: 'motion',
                timestamp: snapshotTimestamp,
                sourceTimestamp: snapshotTimestamp * 1000
            },
            motion: {
                active_ding: true,
                last_ding: motionTimestamp
            },
            ki_burst: {
                status: 'capturing',
                burstId: 'burst-25',
                motionEventTimestamp: 100,
                frames: [null, null, null],
                attributes: {}
            }
        },
        entity: {
            ki_burst_frame_1: { topic: 'frame/1' },
            ki_burst_frame_2: { topic: 'frame/2' },
            ki_burst_frame_3: { topic: 'frame/3' },
            ki_burst_status: { state_topic: 'status', json_attributes_topic: 'status/attr' }
        },
        device: {
            getNextSnapshot: async () => {
                snapshotRequests++
                throw new Error('build-25 must not request another snapshot')
            }
        },
        mqttPublish: (topic, payload) => publishes.push({ topic, payload }),
        debug: message => debug.push(String(message)),
        get snapshotRequests() { return snapshotRequests },
        publishes,
        debugMessages: debug
    }
}

function completionDetails(paths) {
    return {
        burstId: 'burst-25',
        frames: [Buffer.from('HASH_A'), Buffer.from('HASH_B'), Buffer.from('HASH_C')],
        paths,
        frameCount: 3,
        frameSourceIndices: [0, 54, 68],
        frameHashes: ['HASH_A', 'HASH_B', 'HASH_C'],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        minimumSelectionSeparationMs: 1000
    }
}

test('build-25 composes Frame1 from the existing Motion Snapshot while preserving build-24 Frame2 and Frame3', () => {
    const snapshot = Buffer.from('HASH_S')
    const selected = [Buffer.from('HASH_A'), Buffer.from('HASH_B'), Buffer.from('HASH_C')]
    const result = composeKiBurstFrames({
        snapshot,
        snapshotType: 'motion',
        snapshotTimestamp: 100,
        expectedMotionTimestamp: 100,
        currentMotionTimestamp: 100,
        selectedFrames: selected
    })

    assert.equal(result.frames[0].toString(), 'HASH_S')
    assert.equal(result.frames[1].toString(), 'HASH_B')
    assert.equal(result.frames[2].toString(), 'HASH_C')
    assert.notEqual(result.frames[0], snapshot, 'Frame1 must be a copy, not the ordinary snapshot Buffer itself')
    assert.equal(snapshot.toString(), 'HASH_S', 'ordinary Motion Snapshot must remain unchanged')
    assert.equal(result.frames.some(frame => frame.toString() === 'HASH_A'), false, 'build-24 selected[0] must not be published as Frame1')
})

test('final publication duplicates the Motion Snapshot into Frame1 without any additional Ring snapshot request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-build25-'))
    try {
        const paths = [join(dir, 'frame-1.jpg'), join(dir, 'frame-2.jpg'), join(dir, 'frame-3.jpg')]
        await writeFile(paths[0], Buffer.from('HASH_A'))
        await writeFile(paths[1], Buffer.from('HASH_B'))
        await writeFile(paths[2], Buffer.from('HASH_C'))

        const camera = makeCamera()
        const ordinarySnapshotBefore = camera.data.snapshot.cache
        publishBurstState(camera, 'complete', completionDetails(paths))

        assert.equal(camera.snapshotRequests, 0)
        assert.equal(camera.data.snapshot.cache, ordinarySnapshotBefore)
        assert.equal(camera.data.snapshot.cache.toString(), 'HASH_S')
        assert.deepEqual(camera.data.ki_burst.frames.map(frame => frame.toString()), ['HASH_S', 'HASH_B', 'HASH_C'])
        assert.equal((await readFile(paths[0])).toString(), 'HASH_S')
        assert.equal((await readFile(paths[1])).toString(), 'HASH_B')
        assert.equal((await readFile(paths[2])).toString(), 'HASH_C')

        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/1').payload.toString(), 'HASH_S')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/2').payload.toString(), 'HASH_B')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/3').payload.toString(), 'HASH_C')
        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'complete')

        const attrs = JSON.parse(camera.publishes.find(entry => entry.topic === 'status/attr').payload)
        assert.deepEqual(attrs.frameSourceIndices, [0, 54, 68], 'selector diagnostics must remain build-24 selection')
        assert.deepEqual(attrs.outputFrameSourceIndices, [null, 54, 68])
        assert.deepEqual(attrs.outputFrameSources, ['motion_snapshot', 'adaptive_selected_2', 'adaptive_selected_3'])
        assert.deepEqual(attrs.selectorFrameHashes, ['HASH_A', 'HASH_B', 'HASH_C'])
        assert.equal(attrs.frameHashes[0] === 'HASH_A', false, 'published Frame1 hash must describe the Snapshot, not selected[0]')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('a newer Motion cannot leak its Snapshot into an older running Burst', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-build25-retrigger-'))
    try {
        const paths = [join(dir, 'frame-1.jpg'), join(dir, 'frame-2.jpg'), join(dir, 'frame-3.jpg')]
        await Promise.all(paths.map((path, index) => writeFile(path, Buffer.from(`worker-${index + 1}`))))
        const camera = makeCamera({ snapshot: Buffer.from('NEW_MOTION_SNAPSHOT'), snapshotTimestamp: 101, motionTimestamp: 101 })
        camera.data.ki_burst.motionEventTimestamp = 100

        publishBurstState(camera, 'complete', completionDetails(paths))

        assert.equal(camera.data.ki_burst.status, 'failed')
        assert.equal(camera.snapshotRequests, 0)
        assert.equal(camera.publishes.some(entry => entry.topic === 'frame/1'), false)
        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'failed')
        assert.match(camera.data.ki_burst.attributes.error, /Motion changed/)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('status complete is rejected when any of the three final output image files is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-build25-missing-output-'))
    try {
        const paths = [join(dir, 'frame-1.jpg'), join(dir, 'frame-2.jpg'), join(dir, 'frame-3.jpg')]
        await writeFile(paths[0], Buffer.from('HASH_A'))
        await writeFile(paths[1], Buffer.from('HASH_B'))
        const camera = makeCamera()

        publishBurstState(camera, 'complete', completionDetails(paths))

        assert.equal(camera.data.ki_burst.status, 'failed')
        assert.equal(camera.publishes.some(entry => entry.topic.startsWith('frame/')), false)
        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'failed')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('controller watchdog no longer wins the old 13 second finalization race', async () => {
    const states = []
    const sent = []
    let timeoutCallback = null
    let timeoutDelay = null
    const controller = new KiBurstController({
        requestTicket: async () => 'ticket',
        sendWorker: message => sent.push(message),
        onState: (state, details) => states.push({ state, details }),
        setTimer: (callback, delay) => {
            timeoutCallback = callback
            timeoutDelay = delay
            return { id: 1 }
        },
        clearTimer: () => { timeoutCallback = null }
    })

    const burstId = await controller.start()
    assert.equal(KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS, 25000)
    assert.equal(KI_BURST_CONTROLLER_TIMEOUT_MS, 30000)
    assert.equal(timeoutDelay, 30000)
    assert.ok(timeoutDelay > 13000)

    controller.handleWorkerMessage({
        type: 'burst_complete',
        burstId,
        frames: [Buffer.from('A'), Buffer.from('B'), Buffer.from('C')]
    })

    assert.deepEqual(states.map(entry => entry.state), ['capturing', 'complete'])
    assert.equal(controller.running, false)
    assert.equal(timeoutCallback, null, 'successful finalization must clear the watchdog')
    assert.equal(sent.at(-1).command, 'burst')
})
