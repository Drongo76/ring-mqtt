import {
    KI_BURST_FRAME_COUNT,
    KI_BURST_INTERVAL_MS
} from './ki-burst-controller.js'
import {
    assertKiBurstOutputFiles,
    composeKiBurstFrames,
    persistKiBurstFrames
} from './ki-burst-output.js'

export function compactRtpIntegrityForHomeAssistant(rtpIntegrity) {
    const source = rtpIntegrity && typeof rtpIntegrity === 'object' ? rtpIntegrity : {}
    const compact = {}
    for (const field of [
        'acceptedAccessUnits',
        'droppedAccessUnits',
        'resyncs',
        'waitingForKeyframe',
        'reorderedPackets',
        'duplicatePackets',
        'reorderWaitMs',
        'maxReorderPackets'
    ]) {
        if (Number.isFinite(source[field])) compact[field] = source[field]
    }
    if (source.firstForwardedRtpTimestamp === null || Number.isFinite(source.firstForwardedRtpTimestamp)) {
        compact.firstForwardedRtpTimestamp = source.firstForwardedRtpTimestamp
    }
    compact.pendingAccessUnitCount = Array.isArray(source.pendingAccessUnits)
        ? source.pendingAccessUnits.length
        : Number.isInteger(source.pendingAccessUnitCount)
            ? source.pendingAccessUnitCount
            : 0
    return compact
}

export function publishBurstState(camera, status, details = {}) {
    if (!camera.data?.ki_burst) return

    if (status === 'complete' && Array.isArray(details.frames)) {
        const workerDetails = details
        try {
            const snapshot = camera.data?.snapshot || {}
            const motion = camera.data?.motion || {}
            const composed = composeKiBurstFrames({
                snapshot: snapshot.cache,
                snapshotType: snapshot.cacheType,
                snapshotTimestamp: snapshot.timestamp,
                expectedMotionTimestamp: camera.data.ki_burst.motionEventTimestamp,
                currentMotionTimestamp: motion.last_ding,
                selectedFrames: details.frames
            })
            if (!Array.isArray(details.paths) || details.paths.length !== KI_BURST_FRAME_COUNT) {
                throw new Error('KI Burst worker did not provide exactly 3 final output paths')
            }

            assertKiBurstOutputFiles(details.paths)
            persistKiBurstFrames(details.paths, composed.frames)
            assertKiBurstOutputFiles(details.paths)

            const selectorSourceIndices = Array.isArray(details.frameSourceIndices) ? details.frameSourceIndices : []
            const selectorSelectionReasons = Array.isArray(details.selectionReasons) ? details.selectionReasons : []
            const selectorFrameOffsetsMs = Array.isArray(details.frameOffsetsMs) ? details.frameOffsetsMs : []
            const selectorActualFrameOffsetsMs = Array.isArray(details.actualFrameOffsetsMs) ? details.actualFrameOffsetsMs : []
            const selectorDifferenceScores = Array.isArray(details.differenceScores) ? details.differenceScores : []
            const selectorChangedBlockRatios = Array.isArray(details.changedBlockRatios) ? details.changedBlockRatios : []
            const selectorFramePts = Array.isArray(details.framePts) ? details.framePts : []
            const selectorFramePtsTime = Array.isArray(details.framePtsTime) ? details.framePtsTime : []
            const selectorFrameTimestamps = Array.isArray(details.frameTimestamps) ? details.frameTimestamps : []
            const selectorFrameTypes = Array.isArray(details.frameTypes) ? details.frameTypes : []
            const selectorFrameRawChecksums = Array.isArray(details.frameRawChecksums) ? details.frameRawChecksums : []
            const selectorPairF2F3 = Array.isArray(details.pairwiseDifferenceScores)
                ? details.pairwiseDifferenceScores.find(entry => entry?.pair === 'F1-F2') || null
                : null
            const finalSelectorTriplet = (values, first = null) => [first, values[0] ?? null, values[1] ?? null]
            const snapshotCapturedAt = Number.isFinite(Number(snapshot.timestamp))
                ? new Date(Number(snapshot.timestamp) * 1000).toISOString()
                : null
            const snapshotSourceTimestamp = Number.isFinite(Number(snapshot.sourceTimestamp))
                ? Number(snapshot.sourceTimestamp)
                : null
            const finalFrameSourceIndices = finalSelectorTriplet(selectorSourceIndices)

            details = {
                ...details,
                frames: composed.frames,
                frameHashes: composed.frameHashes,
                frameOffsetsMs: finalSelectorTriplet(selectorFrameOffsetsMs),
                actualFrameOffsetsMs: finalSelectorTriplet(selectorActualFrameOffsetsMs),
                differenceScores: finalSelectorTriplet(selectorDifferenceScores),
                changedBlockRatios: finalSelectorTriplet(selectorChangedBlockRatios),
                pairwiseDifferenceScores: selectorPairF2F3 ? [{ ...selectorPairF2F3, pair: 'F2-F3' }] : [],
                totalDiversityScore: null,
                selectionReasons: ['motion_snapshot', selectorSelectionReasons[0] ?? null, selectorSelectionReasons[1] ?? null],
                frameSourceIndices: finalFrameSourceIndices,
                framePts: finalSelectorTriplet(selectorFramePts),
                framePtsTime: finalSelectorTriplet(selectorFramePtsTime),
                frameTimestamps: finalSelectorTriplet(selectorFrameTimestamps, snapshotCapturedAt),
                frameTypes: finalSelectorTriplet(selectorFrameTypes),
                frameRawChecksums: finalSelectorTriplet(selectorFrameRawChecksums),
                outputFrameSources: ['motion_snapshot', 'adaptive_selected_2', 'adaptive_selected_3'],
                outputFrameSourceIndices: finalFrameSourceIndices,
                snapshotCapturedAt,
                snapshotSourceTimestamp
            }

            camera.data.ki_burst.diagnostics = extractInternalDiagnostics(workerDetails)

            camera.debug?.(`KI Burst ${details.burstId || 'unknown'} DIAG snapshot_available ${JSON.stringify({
                at: new Date().toISOString(),
                snapshotCapturedAt,
                snapshotSourceTimestamp,
                expectedMotionTimestamp: camera.data.ki_burst.motionEventTimestamp
            })}`, 'wrtc')
        } catch (error) {
            status = 'failed'
            details = {
                ...details,
                frames: undefined,
                frameCount: 0,
                error: `KI Burst Frame 1 snapshot finalization failed: ${error?.message || error}`
            }
            camera.debug?.(`KI Burst ${details.burstId || 'unknown'} Frame 1 snapshot finalization failed: ${error?.message || error}`, 'wrtc')
        }
    }

    camera.data.ki_burst.status = status
    if (status === 'capturing' || status === 'failed') delete camera.data.ki_burst.diagnostics

    const attrs = {
        status,
        burstId: details.burstId || camera.data.ki_burst.burstId || null,
        frameCount: details.frameCount || (status === 'complete' ? KI_BURST_FRAME_COUNT : 0),
        intervalMs: details.intervalMs || KI_BURST_INTERVAL_MS,
        capturedAt: details.capturedAt || null,
        frameOffsetsMs: details.frameOffsetsMs || [],
        paths: details.paths || [],
        selectionMode: details.selectionMode || null,
        observationWindowMs: Number.isFinite(details.observationWindowMs) ? details.observationWindowMs : null,
        candidateFramesEvaluated: Number.isInteger(details.candidateFramesEvaluated) ? details.candidateFramesEvaluated : 0,
        actualFrameOffsetsMs: Array.isArray(details.actualFrameOffsetsMs) ? details.actualFrameOffsetsMs : [],
        differenceScores: Array.isArray(details.differenceScores) ? details.differenceScores : [],
        changedBlockRatios: Array.isArray(details.changedBlockRatios) ? details.changedBlockRatios : [],
        pairwiseDifferenceScores: Array.isArray(details.pairwiseDifferenceScores) ? details.pairwiseDifferenceScores : [],
        totalDiversityScore: Number.isFinite(details.totalDiversityScore) ? details.totalDiversityScore : null,
        selectionReasons: Array.isArray(details.selectionReasons) ? details.selectionReasons : [],
        selectionThreshold: Number.isFinite(details.selectionThreshold) ? details.selectionThreshold : null,
        minimumSelectionSeparationMs: Number.isFinite(details.minimumSelectionSeparationMs) ? details.minimumSelectionSeparationMs : KI_BURST_INTERVAL_MS,
        firstCleanFrameAt: details.firstCleanFrameAt || null,
        totalBurstDurationMs: Number.isFinite(details.totalBurstDurationMs) ? details.totalBurstDurationMs : null,
        frameSourceIndices: Array.isArray(details.frameSourceIndices) ? details.frameSourceIndices : [],
        framePts: Array.isArray(details.framePts) ? details.framePts : [],
        framePtsTime: Array.isArray(details.framePtsTime) ? details.framePtsTime : [],
        frameTimestamps: Array.isArray(details.frameTimestamps) ? details.frameTimestamps : [],
        frameTypes: Array.isArray(details.frameTypes) ? details.frameTypes : [],
        frameRawChecksums: Array.isArray(details.frameRawChecksums) ? details.frameRawChecksums : [],
        frameHashes: Array.isArray(details.frameHashes) ? details.frameHashes : [],
        outputFrameSources: Array.isArray(details.outputFrameSources) ? details.outputFrameSources : [],
        outputFrameSourceIndices: Array.isArray(details.outputFrameSourceIndices) ? details.outputFrameSourceIndices : [],
        snapshotCapturedAt: details.snapshotCapturedAt || null,
        snapshotSourceTimestamp: Number.isFinite(details.snapshotSourceTimestamp) ? details.snapshotSourceTimestamp : null,
        rtpIntegrity: compactRtpIntegrityForHomeAssistant(details.rtpIntegrity),
        source: details.source === 'warm' ? 'warm' : (details.source === 'cold' ? 'cold' : null),
        preRollMs: Number.isFinite(details.preRollMs) ? details.preRollMs : null,
        replayedUnits: Number.isInteger(details.replayedUnits) ? details.replayedUnits : null,
        ...(camera.data.ki_burst.attributes?.warm ? { warm: camera.data.ki_burst.attributes.warm } : {}),
        ...(details.error ? { error: details.error } : {})
    }

    camera.data.ki_burst.burstId = attrs.burstId
    camera.data.ki_burst.attributes = attrs

    if (status === 'complete' && Array.isArray(details.frames) && details.frames.length === KI_BURST_FRAME_COUNT) {
        camera.data.ki_burst.frames = details.frames
        details.frames.forEach((frame, index) => {
            const entity = camera.entity?.[`ki_burst_frame_${index + 1}`]
            if (entity?.topic) camera.mqttPublish(entity.topic, frame, 'mqtt', '<binary_image_data>')
        })
    }

    const entity = camera.entity?.ki_burst_status
    if (entity?.state_topic) {
        camera.mqttPublish(entity.state_topic, status)
        if (entity.json_attributes_topic) {
            camera.mqttPublish(entity.json_attributes_topic, JSON.stringify(attrs), 'attr')
        }
    }

    if (status === 'complete' && Array.isArray(details.frames)) {
        const completedAt = new Date().toISOString()
        camera.debug?.(`KI Burst ${attrs.burstId || 'unknown'} DIAG frames_published ${JSON.stringify({ at: completedAt })}`, 'wrtc')
        camera.debug?.(`KI Burst ${attrs.burstId || 'unknown'} DIAG status_complete ${JSON.stringify({ at: completedAt })}`, 'wrtc')
    }
}

// Full worker diagnostics. They stay in memory for DEBUG/DIAG and are never part of the public MQTT state:
// raw frame hashes and raw RTP arrays describe the internal selector triplet, not the published frames.
export function extractInternalDiagnostics(details = {}) {
    return {
        actualFrameOffsetsMs: Array.isArray(details.frameOffsetsMs) ? details.frameOffsetsMs : [],
        framePts: Array.isArray(details.framePts) ? details.framePts : [],
        framePtsTime: Array.isArray(details.framePtsTime) ? details.framePtsTime : [],
        frameTimestamps: Array.isArray(details.frameTimestamps) ? details.frameTimestamps : [],
        frameTypes: Array.isArray(details.frameTypes) ? details.frameTypes : [],
        frameRawChecksums: Array.isArray(details.frameRawChecksums) ? details.frameRawChecksums : [],
        frameHashes: Array.isArray(details.frameHashes) ? details.frameHashes : [],
        rtpIntegrity: details.rtpIntegrity && typeof details.rtpIntegrity === 'object' ? details.rtpIntegrity : {}
    }
}

// Re-emits the last published state without recomputing it. Used when the camera republishes
// all of its state (for example after MQTT reconnects).
export function republishBurstState(camera) {
    const burst = camera.data?.ki_burst
    if (!burst) return

    const entity = camera.entity?.ki_burst_status
    if (entity?.state_topic) {
        camera.mqttPublish(entity.state_topic, burst.status)
        if (entity.json_attributes_topic && burst.attributes) {
            camera.mqttPublish(entity.json_attributes_topic, JSON.stringify(burst.attributes), 'attr')
        }
    }
    burst.frames.forEach((frame, index) => {
        const frameEntity = camera.entity?.[`ki_burst_frame_${index + 1}`]
        if (frame && frameEntity?.topic) camera.mqttPublish(frameEntity.topic, frame, 'mqtt', '<binary_image_data>')
    })
}

// Compact warm-source status for Home Assistant. Merged into the status sensor attributes without
// touching the last burst's fields, and kept small: no per-unit data.
export function compactWarmStatus(status = {}, ready = false) {
    const compact = { ready: Boolean(ready) }
    for (const field of ['enabled', 'state', 'degraded', 'consecutiveFailures', 'activeSessionId', 'activeSessionAgeMs', 'rotationPending', 'started', 'rotations', 'failures', 'unexpectedEnds', 'readyTimeouts', 'stalls']) {
        if (status[field] !== undefined && status[field] !== null) compact[field] = status[field]
    }
    const buffer = status.buffer
    if (buffer && typeof buffer === 'object') {
        compact.buffer = {
            gopCount: buffer.gopCount ?? null,
            unitCount: buffer.unitCount ?? null,
            bytes: buffer.bytes ?? null,
            oldestStartAgeMs: buffer.oldestStartAgeMs ?? null,
            newestAgeMs: buffer.newestAgeMs ?? null
        }
    }
    return compact
}

export function publishWarmState(camera, status, ready) {
    const burst = camera.data?.ki_burst
    if (!burst) return
    burst.attributes = { ...burst.attributes, warm: compactWarmStatus(status, ready) }
    const entity = camera.entity?.ki_burst_status
    if (entity?.json_attributes_topic) {
        camera.mqttPublish(entity.json_attributes_topic, JSON.stringify(burst.attributes), 'attr')
    }
}
