import { parentPort, workerData } from 'worker_threads'
import { WebrtcConnection } from '../lib/streaming/webrtc-connection.js'
import { Build12StreamingSession } from '../lib/streaming/build12-streaming-session.js'

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

    // Invalidate first so stale callbacks from this session cannot mutate the next one.
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

    post('log_info', { data: 'Build-12 live worker starting WebRTC session' })

    session.connection.pc.onConnectionState.subscribe(async state => {
        if (!isCurrent(id)) return
        if (state === 'connected') {
            post('state', { kind: 'live', data: 'active', requestId: data.requestId })
            post('log_info', { data: 'Build-12 live WebRTC session connected' })
        } else if (state === 'failed') {
            post('state', { kind: 'live', data: 'failed', requestId: data.requestId })
            await stopActive('connection-failed')
        }
    })

    session.onCallEnded.subscribe(() => {
        if (!isCurrent(id)) return
        active = null
        post('state', { kind: 'live', data: 'inactive', requestId: data.requestId })
        post('log_info', { data: 'Build-12 live WebRTC session ended' })
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
        if (isCurrent(id)) post('log_info', { data: 'Build-12 live ffmpeg process started' })
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

    try {
        const result = await session.captureJpegBurst({
            burstId: data.burstId,
            ...data.options
        })
        if (!isCurrent(id)) return

        // Invalidate before stopping so onCallEnded cannot publish stale state.
        active = null
        session.stop()
        post('burst_complete', {
            burstId: data.burstId,
            frames: result.frames,
            paths: result.paths,
            capturedAt: result.capturedAt,
            intervalMs: result.intervalMs,
            frameOffsetsMs: result.frameOffsetsMs
        })
        post('log_info', { data: `KI Burst ${data.burstId} complete: exactly 3 frames captured` })
    } catch (error) {
        if (!isCurrent(id)) return
        active = null
        try { session.stop() } catch {}
        post('burst_failed', {
            burstId: data.burstId,
            error: error?.message || String(error)
        })
        post('log_error', { data: `KI Burst ${data.burstId} failed: ${error?.stack || error?.message || error}` })
    }
}

async function handleCommand(data) {
    switch (data.command) {
        case 'start':
            await startLive(data)
            break
        case 'burst':
            await startBurst(data)
            break
        case 'stop':
            await stopActive(data.reason || 'stop')
            break
        default:
            post('log_error', { data: `Unknown build-12 worker command: ${data.command}` })
    }
}

parentPort.on('message', data => {
    commandQueue = commandQueue
        .then(() => handleCommand(data))
        .catch(error => post('log_error', { data: error?.stack || error?.message || String(error) }))
})
