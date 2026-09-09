import { createHash } from 'crypto'
import { renameSync, rmSync, statSync, writeFileSync } from 'fs'

function asBuffer(frame, name) {
    if (Buffer.isBuffer(frame)) return frame
    if (frame instanceof Uint8Array) return Buffer.from(frame)
    throw new TypeError(`${name} is not binary image data`)
}

export function kiBurstFrameHash(frame) {
    return createHash('sha256').update(asBuffer(frame, 'KI Burst frame')).digest('hex')
}

export function composeKiBurstFrames({
    snapshot,
    snapshotType,
    snapshotTimestamp,
    expectedMotionTimestamp,
    currentMotionTimestamp,
    selectedFrames
}) {
    const expectedMotion = Number(expectedMotionTimestamp)
    const currentMotion = Number(currentMotionTimestamp)
    const publishedSnapshotAt = Number(snapshotTimestamp)

    if (!Number.isFinite(expectedMotion) || expectedMotion <= 0) {
        throw new Error('KI Burst has no active Motion event to correlate with Frame 1')
    }
    if (!Number.isFinite(currentMotion) || currentMotion !== expectedMotion) {
        throw new Error('KI Burst Motion changed before Frame 1 finalization')
    }
    if (snapshotType !== 'motion') {
        throw new Error(`KI Burst Frame 1 requires Motion Snapshot, current snapshot type is ${snapshotType || 'unknown'}`)
    }
    if (!Number.isFinite(publishedSnapshotAt) || publishedSnapshotAt < expectedMotion) {
        throw new Error('KI Burst Motion Snapshot is older than the active Motion event')
    }
    if (!Array.isArray(selectedFrames) || selectedFrames.length !== 3) {
        throw new Error(`KI Burst expected exactly 3 selected WebRTC frames, received ${Array.isArray(selectedFrames) ? selectedFrames.length : 0}`)
    }

    const snapshotBuffer = asBuffer(snapshot, 'Motion Snapshot')
    const selected = selectedFrames.map((frame, index) => asBuffer(frame, `selected WebRTC frame ${index + 1}`))
    if (!snapshotBuffer.length || selected.some(frame => frame.length === 0)) {
        throw new Error('KI Burst cannot publish an empty image')
    }

    // Frame 1 is a byte-for-byte copy. The ordinary Motion Snapshot remains untouched.
    // Frame 2/3 deliberately stay build-24 selected[1]/selected[2].
    const frames = [Buffer.from(snapshotBuffer), selected[1], selected[2]]
    return {
        frames,
        frameHashes: frames.map(kiBurstFrameHash)
    }
}

export function persistKiBurstFrame1(frame1Path, snapshotFrame) {
    if (typeof frame1Path !== 'string' || !frame1Path) {
        throw new Error('KI Burst Frame 1 output path is missing')
    }
    const frame = asBuffer(snapshotFrame, 'KI Burst Frame 1')
    if (!frame.length) throw new Error('KI Burst Frame 1 is empty')

    const tempPath = `${frame1Path}.snapshot-${process.pid}-${Date.now()}.tmp`
    try {
        writeFileSync(tempPath, frame)
        renameSync(tempPath, frame1Path)
    } finally {
        rmSync(tempPath, { force: true })
    }
}

export function assertKiBurstOutputFiles(paths) {
    if (!Array.isArray(paths) || paths.length !== 3) {
        throw new Error(`KI Burst expected exactly 3 output paths, received ${Array.isArray(paths) ? paths.length : 0}`)
    }
    for (let index = 0; index < paths.length; index++) {
        const stats = statSync(paths[index])
        if (!stats.isFile() || stats.size <= 0) {
            throw new Error(`KI Burst output Frame ${index + 1} is missing or empty`)
        }
    }
    return true
}
