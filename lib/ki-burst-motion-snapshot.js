// Frame 1 of a KI Burst is the Ring Motion Snapshot of the Motion event that started the burst.
//
// The shared snapshot cache (camera.data.snapshot.cache) is overwritten by every later snapshot:
// a doorbell press stores a "ding" snapshot, the interval timer an "interval" snapshot. A visitor
// who walks up (Motion) and presses the bell (Ding) while the burst is still running would
// therefore replace the Motion Snapshot and make the whole burst fail. The Motion Snapshot is
// kept in its own slot, bound to the Motion event it belongs to, that no other snapshot touches.

export function rememberMotionSnapshot(snapshotState, { image, motionTimestamp, capturedAt, sourceTimestamp }) {
    if (!snapshotState || typeof snapshotState !== 'object') {
        throw new TypeError('Snapshot state is required')
    }
    if (!Buffer.isBuffer(image) || image.length === 0) {
        throw new TypeError('Motion Snapshot must be a non-empty Buffer')
    }
    snapshotState.motionCapture = {
        image,
        motionTimestamp: Number(motionTimestamp),
        capturedAt: Number(capturedAt),
        sourceTimestamp: Number.isFinite(Number(sourceTimestamp)) ? Number(sourceTimestamp) : null
    }
}

// Returns the snapshot Frame 1 must be built from, in the shape composeKiBurstFrames expects.
// The Motion Snapshot slot is used only when it belongs to the Motion event of this burst;
// otherwise the shared cache is returned unchanged so that its own checks still apply.
export function selectBurstSnapshot(snapshotState, expectedMotionTimestamp) {
    const state = snapshotState || {}
    const capture = state.motionCapture
    const expected = Number(expectedMotionTimestamp)

    if (capture && Number.isFinite(expected) && expected > 0 && capture.motionTimestamp === expected) {
        return {
            snapshot: capture.image,
            snapshotType: 'motion',
            snapshotTimestamp: capture.capturedAt,
            sourceTimestamp: capture.sourceTimestamp
        }
    }

    return {
        snapshot: state.cache,
        snapshotType: state.cacheType,
        snapshotTimestamp: state.timestamp,
        sourceTimestamp: state.sourceTimestamp
    }
}
