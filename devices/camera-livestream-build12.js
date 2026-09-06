import { parentPort, workerData } from 'worker_threads'
import { WebrtcConnection } from '../lib/streaming/webrtc-connection.js'
import { Build12StreamingSession } from '../lib/streaming/build12-streaming-session.js'
import { captureBurstWithCleanup } from '../lib/ki-burst-worker-session.js'

const cameraData = {
    name: workerData.deviceName,
    id: workerData.doorbotId
}

let active = null
let sequence = 0
let commandQueue = Promise.resolve()

function post(type, data = {}) {
    parentPort.postMessage({ type, ...data })
}

function isCurrent(id) {
    return Boolean(active && active.id === id)
}

async function stopActive(reason = 'stop') {
    const current = active
    if (!current) return

    active = null
    try {
        current.session.stop()
    } catch (error) {
        post('log_error', { data: `Failed stopping ${current.kind} session: ${error?.message || error}` })
    }

    if (current.kind === 'live') {
        post('state', { kind: 'live', data: 'inactive', requestId: current.requestId, reason })
    }
}

async function startLive(data) {
    await stopActive('replaced')
    const id = ++sequence
    const connection = new WebrtcConnection(data.streamData.ticket, cameraData)
    const session = new Build12StreamingSession(cameraData, connection)
    active = { id, kind: 'live', requestId: data.requestId, session }

    post('log_info', { data: 'Build-14 live worker starting WebRTC session' })

    session.connection.pc.onConnectionState.subscribe(async state => {
        if (!isCurrent(id)) return
        if (state === 'connected') {
            post('state', { kind: 'live', data: 'active', requestId: data.requestId })
            post('log_info', { data: 'Build-14 live WebRTC session connected' })
        } else if (state === 'failed') {
            post('state', { kind: 'live', data: 'failed', requestId: data.requestId })
            await stopActive('connection-failed')
        }
    })

    session.onCallEnded.subscribe(() => {
        if (!isCurrent(id)) return
        active = null
        post('state', { kind: 'live', data: 'inactive', requestId: data.requestId })
        post('log_info', { data: 'Build-14 live WebRTC session ended' })
    })

    try {
        await session.startTranscoding({
            audio: [
                '-map', '0:v',
                '-map', '0:a',
                '-map', '0:a',
                '-c:a:0', 'aac',
                '-c:a:1', 'copy'
            ],
            video: ['-c:v', 'copy'],
            output: [
                '-flags', '+global_header',
                '-f', 'rtsp',
                '-rtsp_transport', 'tcp',
                data.streamData.rtspPublishUrl
            ]
        })
        if (isCurrent(id)) post('log_info', { data: 'Build-14 live ffmpeg process started' })
    } catch (error) {
        if (!isCurrent(id)) return
        post('log_error', { data: error?.stack || error?.message || String(error) })
        post('state', { kind: 'live', data: 'failed', requestId: data.requestId })
        await stopActive('start-failed')
    }
}

async function startBurst(data) {
    await stopActive('ki-burst-preflight')
    const id = ++sequence
    const connection = new WebrtcConnection(data.streamData.ticket, cameraData)
    const session = new Build12StreamingSession(cameraData, connection)
    active = { id, kind: 'burst', burstId: data.burstId, session }

    post('log_info', { data: `KI Burst ${data.burstId} starting dedicated WebRTC session` })

    const { result, failure } = await captureBurstWithCleanup({
        session,
        burstId: data.burstId,
        options: data.options,
        onCleanup: () => post('log_info', { data: `KI Burst ${data.burstId} session stopped/cleanup complete` })
    })

    if (!isCurrent(id)) return
    active = null

    if (failure) {
        post('burst_failed', {
            burstId: data.burstId,
            error: failure?.message || String(failure)
        })
        post('log_error', { data: `KI Burst ${data.burstId} failed: ${failure?.stack || failure?.message || failure}` })
        return
    }

    result.frames.forEach((_, index) => {
        const pts = result.framePts?.[index] ?? 'n/a'
        const elapsed = result.actualFrameOffsetsMs?.[index] ?? 'n/a'
        const hash = result.frameHashes?.[index] ?? 'n/a'
        const type = result.frameTypes?.[index] ?? 'n/a'
        const score = result.differenceScores?.[index] ?? 'n/a'
        const ratio = result.changedBlockRatios?.[index] ?? 'n/a'
        const reason = result.selectionReasons?.[index] ?? 'n/a'
        post('log_info', {
            data: `KI Burst ${data.burstId} frame ${index + 1} selected pts=${pts} elapsed=${elapsed}ms type=${type} hash=${hash} diff=${score} changedBlocks=${ratio} reason=${reason}`
        })
    })

    post('log_info', {
        data: `KI Burst ${data.burstId} adaptive selection candidates=${result.candidateFramesEvaluated} threshold=${result.selectionThreshold} reasons=${result.selectionReasons?.join('/')}`
    })

    post('burst_complete', {
        burstId: data.burstId,
        frames: result.frames,
        paths: result.paths,
        capturedAt: result.capturedAt,
        selectionMode: result.selectionMode,
        candidateFramesEvaluated: result.candidateFramesEvaluated,
        frameOffsetsMs: result.frameOffsetsMs,
        actualFrameOffsetsMs: result.actualFrameOffsetsMs,
        differenceScores: result.differenceScores,
        changedBlockRatios: result.changedBlockRatios,
        selectionReasons: result.selectionReasons,
        selectionThreshold: result.selectionThreshold,
        minimumSelectionSeparationMs: result.minimumSelectionSeparationMs,
        framePts: result.framePts,
        framePtsTime: result.framePtsTime,
        frameTimestamps: result.frameTimestamps,
        frameTypes: result.frameTypes,
        frameRawChecksums: result.frameRawChecksums,
        frameHashes: result.frameHashes,
        rtpIntegrity: result.rtpIntegrity
    })
    post('log_info', { data: `KI Burst ${data.burstId} complete: exactly 3 clean decoded frames captured with adaptive selection` })
}

async function handleCommand(data) {
    switch (data.command) {
        case 'start':
            await startLive(data)
            break
        case 'burst':
            await startBurst(data)
            break
        default:
            post('log_error', { data: `Unknown build-14 worker command: ${data.command}` })
    }
}

parentPort.on('message', data => {
    if (data.command === 'stop') {
        stopActive(data.reason || 'stop')
            .catch(error => post('log_error', { data: error?.stack || error?.message || String(error) }))
        return
    }

    commandQueue = commandQueue
        .then(() => handleCommand(data))
        .catch(error => post('log_error', { data: error?.stack || error?.message || String(error) }))
})
