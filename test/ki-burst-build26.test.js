import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
    compactRtpIntegrityForHomeAssistant,
    publishBurstState
} from '../lib/build12-patch.js'
import {
    KI_BURST_CONTROLLER_TIMEOUT_MS,
    KI_BURST_OBSERVATION_WINDOW_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from '../lib/ki-burst-controller.js'
import { H264RtpFrameGate } from '../lib/streaming/h264-rtp-frame-gate.js'

const PUBLIC_ATTRIBUTES_TARGET_BYTES = 8192

function makeHeavyRtpIntegrity() {
    return {
        acceptedAccessUnits: 9999,
        droppedAccessUnits: 333,
        resyncs: 27,
        waitingForKeyframe: 4,
        reorderedPackets: 888,
        duplicatePackets: 777,
        firstForwardedRtpTimestamp: 4294967295,
        reorderWaitMs: 250,
        maxReorderPackets: 64,
        packetDiagnostics: Array.from({ length: 256 }, (_, index) => ({
            arrivalOrder: index + 1,
            timestamp: 123456789 + index,
            sequenceNumber: index,
            marker: Boolean(index % 2),
            fuAStart: false,
            fuAEnd: true,
            reordered: true,
            duplicate: false
        })),
        auDiagnostics: Array.from({ length: 64 }, (_, index) => ({
            timestamp: 200000000 + index,
            startSequence: index,
            markerSequence: index + 100,
            markerSeen: true,
            reorderedPacketCount: 2,
            missingSequenceRanges: Array.from({ length: 20 }, (_, range) => ({ start: range * 4, end: range * 4 + 3 })),
            finalizeReason: null,
            rejectReason: 'reorder-timeout-missing-packets',
            boundedReorderExpiry: true
        })),
        pendingAccessUnits: Array.from({ length: 16 }, (_, index) => ({
            timestamp: 300000000 + index,
            startSequence: index,
            markerSequence: index + 100,
            markerSeen: false,
            reorderedPacketCount: 4,
            missingSequenceRanges: Array.from({ length: 20 }, (_, range) => ({ start: range * 2, end: range * 2 + 1 }))
        }))
    }
}

function makeCamera() {
    const publishes = []
    return {
        data: {
            snapshot: {
                cache: Buffer.from('MOTION_SNAPSHOT_FRAME_1'),
                cacheType: 'motion',
                timestamp: 100,
                sourceTimestamp: 100000
            },
            motion: {
                active_ding: true,
                last_ding: 100
            },
            ki_burst: {
                status: 'capturing',
                burstId: 'burst-26',
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
        mqttPublish: (topic, payload) => publishes.push({ topic, payload }),
        debug: () => {},
        publishes
    }
}

function completionDetails(paths, rtpIntegrity = makeHeavyRtpIntegrity()) {
    return {
        burstId: 'burst-26',
        frames: [Buffer.from('SELECTED_A'), Buffer.from('SELECTED_B'), Buffer.from('SELECTED_C')],
        paths,
        frameCount: 3,
        intervalMs: 1000,
        capturedAt: '2026-09-10T00:00:20.000Z',
        frameOffsetsMs: [0, 1100, 2200],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        candidateFramesEvaluated: 128,
        actualFrameOffsetsMs: [0, 1100, 2200],
        differenceScores: [0, 0.061, 0.084],
        changedBlockRatios: [0, 0.1125, 0.1542],
        pairwiseDifferenceScores: [
            { pair: 'F1-F2', score: 0.31 },
            { pair: 'F2-F3', score: 0.42 },
            { pair: 'F1-F3', score: 0.51 }
        ],
        totalDiversityScore: 1.24,
        selectionReasons: ['first_clean_frame', 'early_visual_change_primary', 'compatibility_tail'],
        selectionThreshold: 0.08,
        minimumSelectionSeparationMs: 1000,
        firstCleanFrameAt: '2026-09-10T00:00:13.500Z',
        totalBurstDurationMs: 19800,
        frameSourceIndices: [0, 20, 40],
        framePts: [0, 99000, 198000],
        framePtsTime: [0, 1.1, 2.2],
        frameTimestamps: [
            '2026-09-10T00:00:13.500Z',
            '2026-09-10T00:00:14.600Z',
            '2026-09-10T00:00:15.700Z'
        ],
        frameTypes: ['I', 'P', 'P'],
        frameRawChecksums: ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC'],
        frameHashes: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
        rtpIntegrity
    }
}

function assertCompactPublicRtpIntegrity(rtpIntegrity) {
    assert.equal(Object.hasOwn(rtpIntegrity, 'packetDiagnostics'), false)
    assert.equal(Object.hasOwn(rtpIntegrity, 'auDiagnostics'), false)
    assert.equal(Object.hasOwn(rtpIntegrity, 'pendingAccessUnits'), false)
    assert.equal(rtpIntegrity.acceptedAccessUnits, 9999)
    assert.equal(rtpIntegrity.droppedAccessUnits, 333)
    assert.equal(rtpIntegrity.resyncs, 27)
    assert.equal(rtpIntegrity.waitingForKeyframe, 4)
    assert.equal(rtpIntegrity.reorderedPackets, 888)
    assert.equal(rtpIntegrity.duplicatePackets, 777)
    assert.equal(rtpIntegrity.firstForwardedRtpTimestamp, 4294967295)
    assert.equal(rtpIntegrity.reorderWaitMs, 250)
    assert.equal(rtpIntegrity.maxReorderPackets, 64)
    assert.equal(rtpIntegrity.pendingAccessUnitCount, 16)
}

function makeRtpPacket({ sequenceNumber = 100, timestamp = 90000, marker = true } = {}) {
    const payload = Buffer.from([0x61, 0x01])
    const packet = Buffer.alloc(12 + payload.length)
    packet[0] = 0x80
    packet[1] = (marker ? 0x80 : 0) | 96
    packet.writeUInt16BE(sequenceNumber, 2)
    packet.writeUInt32BE(timestamp, 4)
    packet.writeUInt32BE(42, 8)
    payload.copy(packet, 12)
    return packet
}

test('build-26 public RTP integrity strips heavy arrays, preserves counters, and is idempotent', () => {
    const full = makeHeavyRtpIntegrity()
    const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
    assert.ok(fullBytes > 16384, `fixture must reproduce an oversized RTP diagnostic object, got ${fullBytes} bytes`)

    const compact = compactRtpIntegrityForHomeAssistant(full)
    assertCompactPublicRtpIntegrity(compact)
    assert.deepEqual(compactRtpIntegrityForHomeAssistant(compact), compact, 'periodic republish compaction must be idempotent')

    assert.equal(full.packetDiagnostics.length, 256, 'compaction must not mutate internal packet diagnostics')
    assert.equal(full.auDiagnostics.length, 64, 'compaction must not mutate internal AU diagnostics')
    assert.equal(full.pendingAccessUnits.length, 16, 'compaction must not mutate internal pending AU diagnostics')
})

test('build-26 full H264 gate diagnostics remain available internally', () => {
    const gate = new H264RtpFrameGate()
    try {
        gate.push(makeRtpPacket())
        const internal = gate.snapshotStats()
        assert.ok(Array.isArray(internal.packetDiagnostics))
        assert.ok(internal.packetDiagnostics.length > 0)
        assert.ok(Array.isArray(internal.auDiagnostics))
        assert.ok(Array.isArray(internal.pendingAccessUnits))
        assert.ok(internal.pendingAccessUnits.length > 0)

        const compact = compactRtpIntegrityForHomeAssistant(internal)
        assert.equal(Object.hasOwn(compact, 'packetDiagnostics'), false)
        assert.equal(Object.hasOwn(compact, 'auDiagnostics'), false)
        assert.equal(Object.hasOwn(compact, 'pendingAccessUnits'), false)
        assert.ok(internal.packetDiagnostics.length > 0, 'public compaction must not remove internal gate diagnostics')
    } finally {
        gate.stop()
    }
})

test('build-26 complete plus three periodic republishes stay compact and never restore heavy RTP arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-build26-'))
    try {
        const paths = [join(dir, 'frame-1.jpg'), join(dir, 'frame-2.jpg'), join(dir, 'frame-3.jpg')]
        await writeFile(paths[0], Buffer.from('SELECTED_A'))
        await writeFile(paths[1], Buffer.from('SELECTED_B'))
        await writeFile(paths[2], Buffer.from('SELECTED_C'))

        const camera = makeCamera()
        publishBurstState(camera, 'complete', completionDetails(paths))

        assert.equal(camera.data.ki_burst.status, 'complete')
        assert.deepEqual(camera.data.ki_burst.frames.map(frame => frame.toString()), [
            'MOTION_SNAPSHOT_FRAME_1',
            'SELECTED_A',
            'SELECTED_B'
        ])
        assertCompactPublicRtpIntegrity(camera.data.ki_burst.attributes.rtpIntegrity)
        assert.deepEqual(camera.data.ki_burst.attributes.outputFrameSources, [
            'motion_snapshot',
            'adaptive_selected_2',
            'adaptive_selected_3'
        ])

        for (let iteration = 0; iteration < 3; iteration++) {
            publishBurstState(camera, camera.data.ki_burst.status, camera.data.ki_burst.attributes)
            assertCompactPublicRtpIntegrity(camera.data.ki_burst.attributes.rtpIntegrity)
            const bytes = Buffer.byteLength(JSON.stringify(camera.data.ki_burst.attributes), 'utf8')
            assert.ok(bytes < PUBLIC_ATTRIBUTES_TARGET_BYTES, `periodic republish ${iteration + 1} is ${bytes} bytes`)
        }

        const attributePublishes = camera.publishes.filter(entry => entry.topic === 'status/attr')
        assert.equal(attributePublishes.length, 4)
        let worstCaseBytes = 0
        for (const publication of attributePublishes) {
            const bytes = Buffer.byteLength(publication.payload, 'utf8')
            worstCaseBytes = Math.max(worstCaseBytes, bytes)
            assert.ok(bytes < PUBLIC_ATTRIBUTES_TARGET_BYTES, `public attributes are ${bytes} bytes`)
            const attrs = JSON.parse(publication.payload)
            assertCompactPublicRtpIntegrity(attrs.rtpIntegrity)
        }
        console.log(`build-26 worst-case public attributes bytes: ${worstCaseBytes}`)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('build-26 Recorder hotfix leaves Burst safety timing behavior unchanged', () => {
    assert.equal(KI_BURST_OBSERVATION_WINDOW_MS, 6000)
    assert.equal(KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS, 25000)
    assert.equal(KI_BURST_CONTROLLER_TIMEOUT_MS, 30000)
})
