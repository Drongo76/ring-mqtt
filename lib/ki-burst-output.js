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

    // Final chronology is Motion Snapshot -> first clean WebRTC candidate -> early adaptive candidate.
    // The third internal WebRTC selection is retained only for the existing worker contract and diagnostics.
    const frames = [Buffer.from(snapshotBuffer), selected[0], selected[1]]
    return {
        frames,
        frameHashes: frames.map(kiBurstFrameHash)
    }
}

function persistKiBurstFrame(framePath, frame, label) {
    if (typeof framePath !== 'string' || !framePath) {
        throw new Error(`${label} output path is missing`)
    }
    const buffer = asBuffer(frame, label)
    if (!buffer.length) throw new Error(`${label} is empty`)

    const tempPath = `${framePath}.final-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    try {
        writeFileSync(tempPath, buffer)
        renameSync(tempPath, framePath)
    } finally {
        rmSync(tempPath, { force: true })
    }
}

export function persistKiBurstFrame1(frame1Path, snapshotFrame) {
    persistKiBurstFrame(frame1Path, snapshotFrame, 'KI Burst Frame 1')
}

export function persistKiBurstFrames(paths, frames) {
    if (!Array.isArray(paths) || paths.length !== 3) {
        throw new Error(`KI Burst expected exactly 3 output paths, received ${Array.isArray(paths) ? paths.length : 0}`)
    }
    if (!Array.isArray(frames) || frames.length !== 3) {
        throw new Error(`KI Burst expected exactly 3 final frames, received ${Array.isArray(frames) ? frames.length : 0}`)
    }
    frames.forEach((frame, index) => persistKiBurstFrame(paths[index], frame, `KI Burst Frame ${index + 1}`))
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
