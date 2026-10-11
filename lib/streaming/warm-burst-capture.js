import { BurstAnalyzer } from './burst-analyzer.js'

export const DEFAULT_PRE_ROLL_MS = 3000
export const DEFAULT_REPLAY_CHUNK_UNITS = 4
export const DEFAULT_REPLAY_CHUNK_DELAY_MS = 2

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class WarmSourceUnavailableError extends Error {
    constructor(message) {
        super(message)
        this.name = 'WarmSourceUnavailableError'
    }
}

// Runs one KI Burst from a warm source: the buffered video from `preRollMs` before now (starting
// at a keyframe) is replayed into the analyzer first, then the same source's live access units
// follow, so the analysis sees one continuous stream that already contains the moments leading
// up to the request.
//
// `warm` is a WarmSessionManager (only activeBuffer/activeSession are used).
// `reservePort()` returns a UDP port for the decoder and `sendPacket(port, packet)` delivers to it.
export async function captureBurstFromWarmSource({
    warm,
    burstId,
    cameraId,
    outputDir,
    ffmpegPath,
    reservePort,
    sendPacket,
    getVideoOnlySdp,
    options = {},
    preRollMs = DEFAULT_PRE_ROLL_MS,
    replayChunkUnits = DEFAULT_REPLAY_CHUNK_UNITS,
    replayChunkDelayMs = DEFAULT_REPLAY_CHUNK_DELAY_MS,
    now = Date.now,
    emit = () => {}
}) {
    const buffer = warm.activeBuffer
    const source = warm.activeSession
    if (!buffer || !source) throw new WarmSourceUnavailableError('No warm video source is available')

    const startedAtMs = now()
    const replay = buffer.extractFrom(startedAtMs - preRollMs)
    if (!replay) throw new WarmSourceUnavailableError('The warm video buffer is empty')

    // Extraction and the live subscription happen in the same synchronous step, so no access unit
    // can fall into the gap between the replayed part and the live part.
    const pendingLive = []
    let replaying = true
    let analyzer = null
    const unsubscribeLive = source.onAccessUnit(unit => {
        if (replaying) pendingLive.push(unit)
        else analyzer?.feed(unit.packets)
    })
    const unsubscribeEnded = source.onEnded(() => analyzer?.stop('warm-source-ended'))

    let sdp
    try {
        sdp = await source.sdp
        const videoPort = await reservePort()
        analyzer = new BurstAnalyzer({
            ...options,
            burstId,
            cameraId,
            outputDir,
            sdp: getVideoOnlySdp(sdp, videoPort),
            ffmpegPath,
            sendPacket: packet => sendPacket(videoPort, packet),
            requestKeyFrame: () => {},
            getRtpIntegrity: () => source.rtpIntegrity(),
            emit
        })
        emit('warm_replay_started', {
            units: replay.units.length,
            replaySpanMs: replay.rtpSpanMs,
            bufferStartedAgoMs: startedAtMs - replay.startedAtMs
        })
        await analyzer.start()

        for (let i = 0; i < replay.units.length; i += replayChunkUnits) {
            for (const unit of replay.units.slice(i, i + replayChunkUnits)) analyzer.feed(unit.packets)
            if (replayChunkDelayMs > 0) await sleep(replayChunkDelayMs)
            if (analyzer.stopRequested) break
        }
        replaying = false
        for (const unit of pendingLive.splice(0)) analyzer.feed(unit.packets)
        emit('warm_replay_finished', { replayedUnits: replay.units.length, replayDurationMs: now() - startedAtMs })

        const result = await analyzer.finish()
        return { ...result, source: 'warm', preRollMs, replayedUnits: replay.units.length, replaySpanMs: replay.rtpSpanMs }
    } finally {
        unsubscribeLive()
        unsubscribeEnded()
        if (analyzer) await analyzer.dispose()
    }
}
