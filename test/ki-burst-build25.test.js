import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { composeKiBurstFrames, kiBurstFrameHash } from '../lib/ki-burst-output.js'
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
        frameOffsetsMs: [0, 1250, 2500],
        actualFrameOffsetsMs: [0, 1250, 2500],
        differenceScores: [0, 0.1, 0.2],
        changedBlockRatios: [0, 0.12, 0.22],
        pairwiseDifferenceScores: [
            { pair: 'F1-F2', score: 0.22, differenceScore: 0.1, changedBlockRatio: 0.12 },
            { pair: 'F2-F3', score: 0.35, differenceScore: 0.15, changedBlockRatio: 0.2 },
            { pair: 'F1-F3', score: 0.41, differenceScore: 0.19, changedBlockRatio: 0.22 }
        ],
        totalDiversityScore: 0.98,
        framePts: [100, 200, 300],
        framePtsTime: [0, 1.25, 2.5],
        frameTimestamps: [
            '2026-09-11T10:00:04.300Z',
            '2026-09-11T10:00:05.550Z',
            '2026-09-11T10:00:06.800Z'
        ],
        frameTypes: ['I', 'P', 'P'],
        frameRawChecksums: ['RAW_A', 'RAW_B', 'RAW_C'],
        frameHashes: [Buffer.from('HASH_A'), Buffer.from('HASH_B'), Buffer.from('HASH_C')].map(kiBurstFrameHash),
        candidateEvaluations: Array.from({ length: 256 }, (_, index) => ({
            index,
            reason: index === 0 ? 'first_clean_frame' : 'buffered_candidate',
            selectedImmediately: index === 0,
            diagnosticPadding: 'x'.repeat(128)
        })),
        selectionReasons: ['first_clean_frame', 'early_low_diversity_fallback', 'compatibility_tail'],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        minimumSelectionSeparationMs: 1000
    }
}

test('final composition is Motion Snapshot -> first clean WebRTC -> early adaptive WebRTC', () => {
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
    assert.equal(result.frames[1].toString(), 'HASH_A')
    assert.equal(result.frames[2].toString(), 'HASH_B')
    assert.notEqual(result.frames[0], snapshot, 'Frame1 must be a copy, not the ordinary snapshot Buffer itself')
    assert.equal(snapshot.toString(), 'HASH_S', 'ordinary Motion Snapshot must remain unchanged')
    assert.equal(result.frames.some(frame => frame.toString() === 'HASH_C'), false, 'compatibility tail must not be published')
})

test('final publication keeps Motion Snapshot as F1 and publishes selected[0]/selected[1] as F2/F3 without another Ring request', async () => {
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
        assert.deepEqual(camera.data.ki_burst.frames.map(frame => frame.toString()), ['HASH_S', 'HASH_A', 'HASH_B'])
        const finalFrame1 = await readFile(paths[0])
        const finalFrame2 = await readFile(paths[1])
        const finalFrame3 = await readFile(paths[2])
        assert.equal(finalFrame1.toString(), 'HASH_S')
        assert.equal(finalFrame2.toString(), 'HASH_A')
        assert.equal(finalFrame3.toString(), 'HASH_B')
        assert.equal(kiBurstFrameHash(finalFrame2), kiBurstFrameHash(Buffer.from('HASH_A')), 'final frame-2 JPEG hash must equal selector selected[0] JPEG hash')
        assert.equal(kiBurstFrameHash(finalFrame3), kiBurstFrameHash(Buffer.from('HASH_B')), 'final frame-3 JPEG hash must equal selector selected[1] JPEG hash')

        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/1').payload.toString(), 'HASH_S')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/2').payload.toString(), 'HASH_A')
        assert.equal(camera.publishes.find(entry => entry.topic === 'frame/3').payload.toString(), 'HASH_B')
        assert.equal(camera.publishes.find(entry => entry.topic === 'status').payload, 'complete')

        const attrs = JSON.parse(camera.publishes.find(entry => entry.topic === 'status/attr').payload)
        assert.deepEqual(attrs.frameSourceIndices, [null, 0, 54], 'public frameSourceIndices must describe final Snapshot/selected[0]/selected[1]')
        assert.deepEqual(attrs.outputFrameSourceIndices, [null, 0, 54])
        assert.deepEqual(attrs.outputFrameSources, ['motion_snapshot', 'adaptive_selected_2', 'adaptive_selected_3'])
        assert.deepEqual(attrs.selectionReasons, ['motion_snapshot', 'first_clean_frame', 'early_low_diversity_fallback'])
        assert.equal(attrs.selectionReasons.length, 3)
        assert.equal(attrs.selectionReasons.includes('compatibility_tail'), false)
        assert.equal(JSON.stringify(attrs).includes('compatibility_tail'), false, 'compatibility tail must not leak anywhere into public MQTT metadata')
        assert.deepEqual(attrs.frameOffsetsMs, [null, 0, 1250])
        assert.deepEqual(attrs.actualFrameOffsetsMs, [null, 0, 1250])
        assert.deepEqual(attrs.differenceScores, [null, 0, 0.1])
        assert.deepEqual(attrs.changedBlockRatios, [null, 0, 0.12])
        assert.deepEqual(attrs.pairwiseDifferenceScores, [
            { pair: 'F2-F3', score: 0.22, differenceScore: 0.1, changedBlockRatio: 0.12 }
        ])
        assert.equal(attrs.totalDiversityScore, null, 'selector-wide diversity includes compatibility_tail and must not masquerade as final-triple diversity')
        assert.deepEqual(attrs.framePts, [null, 100, 200])
        assert.deepEqual(attrs.framePtsTime, [null, 0, 1.25])
        assert.deepEqual(attrs.frameTypes, [null, 'I', 'P'])
        assert.deepEqual(attrs.frameRawChecksums, [null, 'RAW_A', 'RAW_B'])
        assert.equal(attrs.frameTimestamps[0], '1970-01-01T00:01:40.000Z')
        assert.deepEqual(attrs.frameTimestamps.slice(1), ['2026-09-11T10:00:04.300Z', '2026-09-11T10:00:05.550Z'])
        assert.equal(attrs.frameHashes[1], kiBurstFrameHash(Buffer.from('HASH_A')), 'published Frame2 hash must map to selector selected[0]')
        assert.equal(attrs.frameHashes[2], kiBurstFrameHash(Buffer.from('HASH_B')), 'published Frame3 hash must map to selector selected[1]')
        assert.equal(attrs.frameHashes[1], kiBurstFrameHash(finalFrame2), 'published Frame2 hash must match final frame-2 JPEG bytes')
        assert.equal(attrs.frameHashes[2], kiBurstFrameHash(finalFrame3), 'published Frame3 hash must match final frame-3 JPEG bytes')
        assert.equal(Object.hasOwn(attrs, 'selectorFrameHashes'), false, 'internal selector hashes must not be exposed as final-frame metadata')
        assert.equal(Object.hasOwn(attrs, 'candidateEvaluations'), false, 'candidateEvaluations must remain internal/debug only')
        assert.ok(Buffer.byteLength(JSON.stringify(attrs), 'utf8') < 8192, 'public metadata must stay compact for Recorder')
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

test('status complete is rejected when any of the three worker output image files is missing before final composition', async () => {
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
