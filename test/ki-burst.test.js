import test from 'node:test'
import assert from 'node:assert/strict'
import {
    KiBurstController,
    normalizeBurstFrames,
    KI_BURST_CONTROLLER_TIMEOUT_MS,
    KI_BURST_INTERVAL_MS,
    KI_BURST_OBSERVATION_WINDOW_MS,
    KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS
} from '../lib/ki-burst-controller.js'
import { captureBurstWithCleanup } from '../lib/ki-burst-worker-session.js'
import {
    buildBurstFfmpegArgs,
    candidateFilenameForSourceIndex,
    DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS,
    parseShowinfoFrameLine
} from '../lib/streaming/build12-streaming-session.js'
import { H264RtpFrameGate, parseRtpPacket, payloadStartsH264Idr } from '../lib/streaming/h264-rtp-frame-gate.js'
import { homeAssistantSlug } from '../lib/build12-patch.js'
import { removeBrokenStillImageUrl } from '../lib/build14-patch.js'
import Camera from '../devices/camera.js'

function makeController({ timeoutMs = KI_BURST_CONTROLLER_TIMEOUT_MS } = {}) {
    const sent = []
    const states = []
    let ticketRequests = 0
    let timeoutCallback = null
    let timerDelayMs = null
    const controller = new KiBurstController({
        requestTicket: async () => {
            ticketRequests++
            return 'ticket-1'
        },
        sendWorker: message => sent.push(message),
        onState: (state, details) => states.push({ state, details }),
        timeoutMs,
        setTimer: (callback, delayMs) => {
            timeoutCallback = callback
            timerDelayMs = delayMs
            return { id: 1 }
        },
        clearTimer: () => { timeoutCallback = null }
    })
    return {
        controller,
        sent,
        states,
        get ticketRequests() { return ticketRequests },
        get timerDelayMs() { return timerDelayMs },
        fireTimeout: () => timeoutCallback?.()
    }
}

function makeRtp({ sequenceNumber, timestamp, marker = false, ssrc = 42, payload }) {
    const packet = Buffer.alloc(12 + payload.length)
    packet[0] = 0x80
    packet[1] = (marker ? 0x80 : 0) | 96
    packet.writeUInt16BE(sequenceNumber & 0xffff, 2)
    packet.writeUInt32BE(timestamp >>> 0, 4)
    packet.writeUInt32BE(ssrc >>> 0, 8)
    payload.copy(packet, 12)
    return packet
}

test('KI Burst opens one dedicated session with buffered observation and completes with exactly three frames', async () => {
    const fixture = makeController()
    const burstId = await fixture.controller.start()
    assert.equal(fixture.ticketRequests, 1)
    assert.equal(fixture.sent.filter(message => message.command === 'burst').length, 1)
    assert.deepEqual(fixture.sent.map(message => message.command), ['stop', 'burst'])
    assert.equal(fixture.sent[1].options.minSeparationMs, KI_BURST_INTERVAL_MS)
    assert.equal(fixture.sent[1].options.observationWindowMs, KI_BURST_OBSERVATION_WINDOW_MS)
    assert.equal(fixture.sent[1].options.hardSafetyTimeoutMs, KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS)
    assert.equal(fixture.timerDelayMs, KI_BURST_CONTROLLER_TIMEOUT_MS)

    const frames = [Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('frame-3')]
    const pairwiseDifferenceScores = [
        { pair: 'F1-F2', score: 0.31 },
        { pair: 'F2-F3', score: 0.42 },
        { pair: 'F1-F3', score: 0.51 }
    ]
    const handled = fixture.controller.handleWorkerMessage({
        type: 'burst_complete',
        burstId,
        frames,
        paths: ['/data/1.jpg', '/data/2.jpg', '/data/3.jpg'],
        selectionMode: 'adaptive_buffered',
        observationWindowMs: 6000,
        candidateFramesEvaluated: 62,
        actualFrameOffsetsMs: [0, 3200, 6050],
        differenceScores: [0, 0.061, 0.084],
        changedBlockRatios: [0, 0.1125, 0.1542],
        pairwiseDifferenceScores,
        totalDiversityScore: 1.24,
        selectionReasons: ['first_clean_frame', 'global_diversity', 'global_diversity'],
        selectionThreshold: 0.08,
        minimumSelectionSeparationMs: 1000,
        firstCleanFrameAt: '2026-09-06T08:00:00.000Z',
        totalBurstDurationMs: 7350,
        frameSourceIndices: [0, 31, 61],
        framePts: [0, 288000, 544500],
        framePtsTime: [0, 3.2, 6.05],
        frameTimestamps: ['2026-09-06T08:00:00.000Z', '2026-09-06T08:00:03.200Z', '2026-09-06T08:00:06.050Z'],
        frameTypes: ['I', 'P', 'P'],
        frameRawChecksums: ['A', 'B', 'C'],
        frameHashes: ['a', 'b', 'c'],
        rtpIntegrity: { acceptedAccessUnits: 80 },
        capturedAt: '2026-09-06T08:00:07.350Z'
    })

    assert.equal(handled, true)
    assert.equal(fixture.controller.running, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'complete'])
    const details = fixture.states.at(-1).details
    assert.equal(details.frames.length, 3)
    assert.equal(details.selectionMode, 'adaptive_buffered')
    assert.equal(details.observationWindowMs, 6000)
    assert.equal(details.candidateFramesEvaluated, 62)
    assert.deepEqual(details.actualFrameOffsetsMs, [0, 3200, 6050])
    assert.deepEqual(details.targetFrameOffsetsMs, [])
    assert.deepEqual(details.pairwiseDifferenceScores, pairwiseDifferenceScores)
    assert.deepEqual(details.selectionReasons, ['first_clean_frame', 'global_diversity', 'global_diversity'])
    assert.equal(details.firstCleanFrameAt, '2026-09-06T08:00:00.000Z')
    assert.equal(details.totalBurstDurationMs, 7350)
    assert.deepEqual(details.framePts, [0, 288000, 544500])
    assert.deepEqual(details.frameHashes, ['a', 'b', 'c'])
    assert.equal(fixture.sent.some(message => message.command === 'start'), false)
})

test('controller and worker hard deadlines remain below the existing 15 second HA wait', () => {
    assert.equal(KI_BURST_OBSERVATION_WINDOW_MS, 6000)
    assert.equal(KI_BURST_INTERVAL_MS, 1000)
    assert.equal(KI_BURST_WORKER_HARD_SAFETY_TIMEOUT_MS, 12500)
    assert.equal(DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS, 12500)
    assert.equal(KI_BURST_CONTROLLER_TIMEOUT_MS, 13000)
    assert.ok(KI_BURST_CONTROLLER_TIMEOUT_MS < 15000)
})

test('KI Burst timeout stops the worker and cannot be resurrected by a late completion callback', async () => {
    const fixture = makeController({ timeoutMs: 100 })
    const burstId = await fixture.controller.start()
    fixture.fireTimeout()
    assert.equal(fixture.controller.running, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'failed'])
    assert.deepEqual(fixture.sent.map(message => message.command), ['stop', 'burst', 'stop'])
    const lateHandled = fixture.controller.handleWorkerMessage({ type: 'burst_complete', burstId, frames: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')] })
    assert.equal(lateHandled, false)
})

test('KI Burst rejects incomplete worker output instead of publishing a partial burst', async () => {
    const fixture = makeController()
    const burstId = await fixture.controller.start()
    fixture.controller.handleWorkerMessage({ type: 'burst_complete', burstId, frames: [Buffer.from('frame-1'), Buffer.from('frame-2')] })
    assert.equal(fixture.controller.running, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'failed'])
    assert.equal(fixture.sent.at(-1).command, 'stop')
})

test('burst frame normalization accepts worker Uint8Array payloads and preserves exactly three frames', () => {
    const frames = normalizeBurstFrames([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])])
    assert.equal(frames.length, 3)
})

test('ffmpeg emits every decoded frame to paired full-JPEG and luma branches without fixed selection offsets', () => {
    const args = buildBurstFfmpegArgs({ candidatePattern: '/tmp/candidate-%06d.jpg' })
    const filter = args[args.indexOf('-filter_complex') + 1]
    assert.match(filter, /setpts=PTS-STARTPTS,showinfo@decoded,split=2/)
    assert.match(filter, /showinfo@full/)
    assert.match(filter, /scale=160:90/)
    assert.match(filter, /showinfo@luma/)
    assert.equal(filter.includes('select='), false)
    assert.equal(filter.includes('fps='), false)
    assert.equal(args.includes('-frames:v'), false)
    assert.equal(args.includes('+discardcorrupt'), true)
    assert.equal(args.includes('rawvideo'), true)
    assert.equal(args.includes('image2'), true)
    assert.equal(args[args.indexOf('-start_number') + 1], '0')
    assert.equal(args.includes('-frame_pts'), false)
    assert.equal(args.at(-1), '/tmp/candidate-%06d.jpg')
})

test('decoded, full JPEG branch and luma branch carry the exact same source index and PTS', () => {
    const decoded = parseShowinfoFrameLine('[Parsed_showinfo@decoded_0 @ 0x1] n:  17 pts:  288000 pts_time:3.2 type:P checksum:AAAA1111')
    const full = parseShowinfoFrameLine('[Parsed_showinfo@full_1 @ 0x2] n:  17 pts:  288000 pts_time:3.2 type:P checksum:AAAA1111')
    const luma = parseShowinfoFrameLine('[Parsed_showinfo@luma_2 @ 0x3] n:  17 pts:  288000 pts_time:3.2 type:P checksum:BBBB2222')

    assert.equal(decoded.stage, 'decoded')
    assert.equal(full.stage, 'full')
    assert.equal(luma.stage, 'luma')
    assert.equal(decoded.index, full.index)
    assert.equal(decoded.index, luma.index)
    assert.equal(decoded.pts, full.pts)
    assert.equal(decoded.pts, luma.pts)
    assert.equal(candidateFilenameForSourceIndex(decoded.index), 'candidate-000017.jpg')
})

test('showinfo parser exposes decoder PTS and timestamp diagnostics', () => {
    const line = '[Parsed_showinfo_2 @ 0x123] n:   1 pts:  78000 pts_time:0.866667 duration:3000 fmt:yuv420p iskey:0 type:P checksum:ABCDEF12'
    const frame = parseShowinfoFrameLine(line, '2026-09-05T17:00:00.867Z')
    assert.equal(frame.stage, 'decoded')
    assert.equal(frame.index, 1)
    assert.equal(frame.pts, 78000)
    assert.equal(frame.ptsTime, 0.866667)
    assert.equal(frame.pictType, 'P')
    assert.equal(frame.rawChecksum, 'ABCDEF12')
    assert.equal(frame.observedAt, '2026-09-05T17:00:00.867Z')
})

test('RTP parser and H264 IDR detection use real RTP sequence/timestamp data', () => {
    const idrStartPayload = Buffer.from([0x7c, 0x85, 0x01])
    const packet = makeRtp({ sequenceNumber: 100, timestamp: 90000, payload: idrStartPayload })
    const parsed = parseRtpPacket(packet)
    assert.equal(parsed.sequenceNumber, 100)
    assert.equal(parsed.timestamp, 90000)
    assert.equal(parsed.marker, false)
    assert.equal(payloadStartsH264Idr(parsed.payload), true)
})

test('RTP integrity gate starts on a complete IDR, rejects a broken access unit, and resyncs on a fresh IDR', () => {
    let keyframeRequests = 0
    const gate = new H264RtpFrameGate({ requestKeyFrame: () => { keyframeRequests++ } })
    const idrStart = Buffer.from([0x7c, 0x85, 0x01])
    const idrEnd = Buffer.from([0x7c, 0x45, 0x02])
    const pSlice = Buffer.from([0x61, 0x01])

    assert.equal(gate.push(makeRtp({ sequenceNumber: 100, timestamp: 90000, payload: idrStart })), null)
    const first = gate.push(makeRtp({ sequenceNumber: 101, timestamp: 90000, marker: true, payload: idrEnd }))
    assert.equal(first.accepted, true)
    assert.equal(first.keyframe, true)
    assert.deepEqual(first.packets.map(packet => packet.readUInt16BE(2)), [0, 1])

    const second = gate.push(makeRtp({ sequenceNumber: 102, timestamp: 93000, marker: true, payload: pSlice }))
    assert.equal(second.accepted, true)
    assert.deepEqual(second.packets.map(packet => packet.readUInt16BE(2)), [2])

    assert.equal(gate.push(makeRtp({ sequenceNumber: 103, timestamp: 96000, payload: pSlice })), null)
    const broken = gate.push(makeRtp({ sequenceNumber: 105, timestamp: 96000, marker: true, payload: pSlice }))
    assert.equal(broken.accepted, false)
    assert.equal(broken.reason, 'incomplete-access-unit')
    assert.equal(keyframeRequests, 1)

    const waiting = gate.push(makeRtp({ sequenceNumber: 106, timestamp: 99000, marker: true, payload: pSlice }))
    assert.equal(waiting.accepted, false)
    assert.equal(waiting.reason, 'waiting-keyframe')

    assert.equal(gate.push(makeRtp({ sequenceNumber: 107, timestamp: 102000, payload: idrStart })), null)
    const resynced = gate.push(makeRtp({ sequenceNumber: 108, timestamp: 102000, marker: true, payload: idrEnd }))
    assert.equal(resynced.accepted, true)
    assert.deepEqual(resynced.packets.map(packet => packet.readUInt16BE(2)), [3, 4])

    const stats = gate.snapshotStats()
    assert.equal(stats.droppedAccessUnits, 1)
    assert.equal(stats.resyncs, 1)
    assert.equal(stats.waitingForKeyframe, 1)
})

test('worker burst cleanup stops the session after successful capture before returning result', async () => {
    let stops = 0
    let cleaned = false
    const session = {
        captureJpegBurst: async () => ({ frames: [Buffer.from('1'), Buffer.from('2'), Buffer.from('3')] }),
        stop: () => { stops++ }
    }
    const { result, failure } = await captureBurstWithCleanup({ session, burstId: 'ok', onCleanup: () => { cleaned = true } })
    assert.equal(stops, 1)
    assert.equal(cleaned, true)
    assert.equal(failure, null)
    assert.equal(result.frames.length, 3)
})

test('worker burst cleanup stops the session on capture failure', async () => {
    let stops = 0
    const session = {
        captureJpegBurst: async () => { throw new Error('capture failed') },
        stop: () => { stops++ }
    }
    const { result, failure } = await captureBurstWithCleanup({ session, burstId: 'fail' })
    assert.equal(stops, 1)
    assert.equal(result, null)
    assert.match(failure.message, /capture failed/)
})

test('build-14 removes broken Jinja still_Image_URL so JSON publication omits the field', () => {
    const camera = {
        data: {
            stream: {
                live: {
                    streamSource: 'rtsp://ring/live',
                    stillImageURL: 'https://homeassistant:8123{{ states.camera.haustur_snapshot.attributes.entity_picture }}'
                }
            }
        }
    }
    removeBrokenStillImageUrl(camera)
    const attributes = {
        stream_Source: camera.data.stream.live.streamSource,
        still_Image_URL: camera.data.stream.live.stillImageURL
    }
    const json = JSON.stringify(attributes)
    assert.equal(json.includes('still_Image_URL'), false)
    assert.equal(json.includes('{{ states.camera.haustur_snapshot.attributes.entity_picture }}'), false)
})

test('Home Assistant still-image slug handles umlauts such as Haustür', () => {
    assert.equal(homeAssistantSlug('Haustür'), 'haustur')
    assert.equal(homeAssistantSlug('Vordere Tür Kamera'), 'vordere_tur_kamera')
})

test('snapshot mode validation rejects values outside the configured options', () => {
    const camera = Object.create(Camera.prototype)
    camera.entity = { snapshot_mode: { options: ['Auto', 'Motion', 'Disabled'] } }
    camera.data = { snapshot: { mode: 'Auto', autoInterval: true, intervalTimerId: null } }
    camera.debug = () => {}
    camera.updateSnapshotMode = () => { camera.updated = true }
    camera.publishSnapshotMode = () => { camera.published = true }
    camera.updateDeviceState = () => { camera.saved = true }
    camera.scheduleSnapshotRefresh = () => {}
    camera.publishSnapshotInterval = () => {}
    camera.setSnapshotMode('Definitely Invalid')
    assert.equal(camera.data.snapshot.mode, 'Auto')
    assert.equal(camera.updated, undefined)
})
