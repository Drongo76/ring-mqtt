import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { publishBurstState } from '../lib/build12-patch.js'
import {
    publishBuild14BurstDiagnostics,
    republishStoredBuild14Diagnostics
} from '../lib/build14-patch.js'
import {
    KI_BURST_CONTROLLER_TIMEOUT_MS,
    KI_BURST_OBSERVATION_WINDOW_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from '../lib/ki-burst-controller.js'

const PUBLIC_ATTRIBUTES_TARGET_BYTES = 8192

function makeHeavyRtpIntegrity() {
    return {
        acceptedAccessUnits: 321,
        droppedAccessUnits: 12,
        resyncs: 3,
        waitingForKeyframe: 4,
        reorderedPackets: 55,
        duplicatePackets: 66,
        firstForwardedRtpTimestamp: 987654321,
        reorderWaitMs: 250,
        maxReorderPackets: 64,
        packetDiagnostics: Array.from({ length: 256 }, (_, index) => ({
            arrivalOrder: index + 1,
            timestamp: 90000 + index,
            sequenceNumber: index,
            marker: Boolean(index % 2),
            fuAStart: Boolean(index % 3),
            fuAEnd: Boolean(index % 5),
            reordered: Boolean(index % 7),
            duplicate: Boolean(index % 11)
        })),
        auDiagnostics: Array.from({ length: 64 }, (_, index) => ({
            timestamp: 180000 + index,
            startSequence: index,
            markerSequence: index + 100,
            markerSeen: true,
            reorderedPacketCount: index % 4,
            missingSequenceRanges: Array.from({ length: 20 }, (_, range) => ({
                start: range * 4,
                end: range * 4 + 3
            })),
            finalizeReason: null,
            rejectReason: 'reorder-timeout-missing-packets',
            boundedReorderExpiry: true
        })),
        pendingAccessUnits: Array.from({ length: 16 }, (_, index) => ({
            timestamp: 270000 + index,
            startSequence: index,
            markerSequence: index + 200,
            markerSeen: false,
            reorderedPacketCount: index % 5,
            missingSequenceRanges: Array.from({ length: 20 }, (_, range) => ({
                start: range * 2,
                end: range * 2 + 1
            }))
        }))
    }
}

function makeCamera() {
    const publishes = []
    return {
        data: {
            snapshot: {
                cache: Buffer.from('BUILD27_MOTION_SNAPSHOT'),
                cacheType: 'motion',
                timestamp: 1789019658,
                sourceTimestamp: 1789019658123
            },
            motion: {
                active_ding: true,
                last_ding: 1789019645
            },
            ki_burst: {
                status: 'capturing',
                burstId: '1789019645043-1',
                motionEventTimestamp: 1789019645,
                frames: [null, null, null],
                attributes: {}
            }
        },
        entity: {
            ki_burst_frame_1: { topic: 'frame/1' },
            ki_burst_frame_2: { topic: 'frame/2' },
            ki_burst_frame_3: { topic: 'frame/3' },
            ki_burst_status: {
                state_topic: 'status',
                json_attributes_topic: 'status/attr'
            }
        },
        mqttPublish: (topic, payload) => publishes.push({ topic, payload }),
        debug: () => {},
        publishes
    }
}

function completionDetails(paths, rtpIntegrity) {
    return {
        burstId: '1789019645043-1',
        frames: [
            Buffer.from('SELECTOR_FRAME_A'),
            Buffer.from('SELECTOR_FRAME_B'),
            Buffer.from('SELECTOR_FRAME_C')
        ],
        paths,
        frameCount: 3,
        intervalMs: 1000,
        capturedAt: '2026-09-10T07:54:18.190+02:00',
        frameOffsetsMs: [0, 3150, 6020],
        actualFrameOffsetsMs: [0, 3150, 6020],
        targetFrameOffsetsMs: [],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        candidateFramesEvaluated: 96,
        differenceScores: [0, 0.07, 0.11],
        changedBlockRatios: [0, 0.12, 0.18],
        pairwiseDifferenceScores: [
            { pair: 'F1-F2', score: 0.31 },
            { pair: 'F2-F3', score: 0.44 },
            { pair: 'F1-F3', score: 0.53 }
        ],
        totalDiversityScore: 1.28,
        selectionReasons: ['first_clean_frame', 'global_diversity', 'global_diversity'],
        selectionThreshold: 0.08,
        minimumSelectionSeparationMs: 1000,
        firstCleanFrameAt: '2026-09-10T07:54:12.150+02:00',
        totalBurstDurationMs: 13157,
        frameSourceIndices: [0, 54, 86],
        framePts: [0, 283500, 541800],
        framePtsTime: [0, 3.15, 6.02],
        frameTimestamps: [
            '2026-09-10T07:54:12.150+02:00',
            '2026-09-10T07:54:15.300+02:00',
            '2026-09-10T07:54:18.170+02:00'
        ],
        frameTypes: ['I', 'P', 'P'],
        frameRawChecksums: ['RAW_A', 'RAW_B', 'RAW_C'],
        frameHashes: [
            'a'.repeat(64),
            'b'.repeat(64),
            'c'.repeat(64)
        ],
        rtpIntegrity
    }
}

function assertNoHeavyRtpArrays(attributes, label) {
    assert.equal(Object.hasOwn(attributes.rtpIntegrity, 'packetDiagnostics'), false, `${label}: packetDiagnostics leaked`)
    assert.equal(Object.hasOwn(attributes.rtpIntegrity, 'auDiagnostics'), false, `${label}: auDiagnostics leaked`)
    assert.equal(Object.hasOwn(attributes.rtpIntegrity, 'pendingAccessUnits'), false, `${label}: pendingAccessUnits leaked`)
    const bytes = Buffer.byteLength(JSON.stringify(attributes), 'utf8')
    assert.ok(bytes < PUBLIC_ATTRIBUTES_TARGET_BYTES, `${label}: public attributes are ${bytes} bytes`)
    return bytes
}

test('build-27 complete -> immediate build14 publish -> periodic republishes never restore raw RTP or selector Frame1 hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ki-burst-build27-lifecycle-'))
    try {
        const paths = [join(dir, 'frame-1.jpg'), join(dir, 'frame-2.jpg'), join(dir, 'frame-3.jpg')]
        await writeFile(paths[0], Buffer.from('SELECTOR_FRAME_A'))
        await writeFile(paths[1], Buffer.from('SELECTOR_FRAME_B'))
        await writeFile(paths[2], Buffer.from('SELECTOR_FRAME_C'))

        const camera = makeCamera()
        const fullRtpIntegrity = makeHeavyRtpIntegrity()
        const details = completionDetails(paths, fullRtpIntegrity)
        const selectorFrame1Hash = details.frameHashes[0]

        assert.ok(
            Buffer.byteLength(JSON.stringify(fullRtpIntegrity), 'utf8') > 16384,
            'fixture must reproduce the oversized build-26 raw RTP diagnostics'
        )

        // First/current build12 publish: Snapshot substitution creates the canonical public state.
        publishBurstState(camera, 'complete', details)
        const firstPublish = JSON.parse(camera.publishes.filter(entry => entry.topic === 'status/attr').at(-1).payload)
        const snapshotFrame1Hash = firstPublish.frameHashes[0]
        assert.notEqual(snapshotFrame1Hash, selectorFrame1Hash, 'Frame1 public hash must describe Motion Snapshot')
        assert.deepEqual(firstPublish.outputFrameSourceIndices, [null, 0, 54], 'final published source indices must map Snapshot, selected[0], selected[1]')
        assert.deepEqual(firstPublish.outputFrameSources, ['motion_snapshot', 'adaptive_selected_2', 'adaptive_selected_3'])
        assertNoHeavyRtpArrays(firstPublish, 'first publish')

        const canonical = {
            frameHashes: [...firstPublish.frameHashes],
            outputFrameSources: [...firstPublish.outputFrameSources],
            outputFrameSourceIndices: [...firstPublish.outputFrameSourceIndices],
            snapshotCapturedAt: firstPublish.snapshotCapturedAt,
            snapshotSourceTimestamp: firstPublish.snapshotSourceTimestamp
        }

        // This is the exact compatibility path that caused the immediate second raw publish in build-26.
        publishBuild14BurstDiagnostics(camera, details)

        // Subsequent camera polling invokes this stored diagnostics republisher.
        republishStoredBuild14Diagnostics(camera)
        republishStoredBuild14Diagnostics(camera)

        const attributePublishes = camera.publishes.filter(entry => entry.topic === 'status/attr')
        assert.equal(attributePublishes.length, 4)

        let worstCaseBytes = 0
        for (const [index, publication] of attributePublishes.entries()) {
            const attrs = JSON.parse(publication.payload)
            worstCaseBytes = Math.max(worstCaseBytes, assertNoHeavyRtpArrays(attrs, `publish ${index + 1}`))
            assert.deepEqual(attrs.frameHashes, canonical.frameHashes, `publish ${index + 1}: frameHashes regressed to selector values`)
            assert.equal(attrs.frameHashes[0], snapshotFrame1Hash, `publish ${index + 1}: Frame1 hash changed`)
            assert.notEqual(attrs.frameHashes[0], selectorFrame1Hash, `publish ${index + 1}: selector Frame1 hash leaked back`)
            assert.deepEqual(attrs.outputFrameSources, canonical.outputFrameSources)
            assert.deepEqual(attrs.outputFrameSourceIndices, canonical.outputFrameSourceIndices)
            assert.equal(attrs.snapshotCapturedAt, canonical.snapshotCapturedAt)
            assert.equal(attrs.snapshotSourceTimestamp, canonical.snapshotSourceTimestamp)
        }

        assertNoHeavyRtpArrays(camera.data.ki_burst.attributes, 'stored public state')
        assert.deepEqual(camera.data.ki_burst.attributes.frameHashes, canonical.frameHashes)
        assert.deepEqual(camera.data.ki_burst.attributes.outputFrameSources, canonical.outputFrameSources)
        assert.deepEqual(camera.data.ki_burst.attributes.outputFrameSourceIndices, canonical.outputFrameSourceIndices)
        assert.equal(camera.data.ki_burst.attributes.snapshotCapturedAt, canonical.snapshotCapturedAt)
        assert.equal(camera.data.ki_burst.attributes.snapshotSourceTimestamp, canonical.snapshotSourceTimestamp)

        // Full build14/runtime diagnostics remain intact and available internally only.
        assert.equal(camera.data.ki_burst.build14Diagnostics.frameHashes[0], selectorFrame1Hash)
        assert.equal(camera.data.ki_burst.build14Diagnostics.rtpIntegrity.packetDiagnostics.length, 256)
        assert.equal(camera.data.ki_burst.build14Diagnostics.rtpIntegrity.auDiagnostics.length, 64)
        assert.equal(camera.data.ki_burst.build14Diagnostics.rtpIntegrity.pendingAccessUnits.length, 16)
        assert.equal(fullRtpIntegrity.packetDiagnostics.length, 256, 'public sanitizing must not mutate internal diagnostics')

        console.log(`build-27 worst-case lifecycle public attributes bytes: ${worstCaseBytes}`)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('build-27 public-state hotfix leaves Burst timing constants unchanged', () => {
    assert.equal(KI_BURST_OBSERVATION_WINDOW_MS, 6000)
    assert.equal(KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS, 25000)
    assert.equal(KI_BURST_CONTROLLER_TIMEOUT_MS, 30000)
})
