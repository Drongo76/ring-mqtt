import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplaySubject, Subject } from 'rxjs'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { Build12StreamingSession } from '../lib/streaming/build12-streaming-session.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function bindUdpSocket(socket) {
    await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(0, '127.0.0.1', () => {
            socket.removeListener('error', reject)
            resolve()
        })
    })
    return socket.address().port
}

async function collectRealH264Rtp(tempDir) {
    const socket = dgram.createSocket('udp4')
    const port = await bindUdpSocket(socket)
    const packets = []
    socket.on('message', message => packets.push(Buffer.from(message)))

    const sdpPath = join(tempDir, 'source.sdp')
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'testsrc2=size=320x180:rate=20:duration=1.5',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-g', '10',
        '-keyint_min', '10',
        '-sc_threshold', '0',
        '-x264-params', 'repeat-headers=1',
        '-payload_type', '96',
        '-f', 'rtp',
        '-sdp_file', sdpPath,
        `rtp://127.0.0.1:${port}?pkt_size=1100`
    ]

    const child = spawn(pathToFfmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
    })
    await sleep(100)
    socket.close()

    assert.equal(code, 0, `RTP fixture ffmpeg failed: ${stderr}`)
    assert.ok(packets.length > 10, `expected real H264 RTP fixture packets, got ${packets.length}`)
    const rawSdp = await readFile(sdpPath, 'utf8')
    assert.match(rawSdp, /m=video\s+\d+\s+RTP\/AVP\s+96/)
    assert.match(rawSdp, /a=rtpmap:96 H264\/90000/i)

    // Ring answers include a usable connection address in the media section that
    // getVideoOnlySdp preserves. ffmpeg's generated fixture SDP usually puts c=
    // only at session scope, which getVideoOnlySdp deliberately strips. Add the
    // equivalent media-local IPv4 c= line so this fixture exercises the Ring path.
    const sdp = rawSdp.replace(/(m=video[^\n]*\n)/, '$1c=IN IP4 127.0.0.1\n')
    return { packets, sdp }
}

class SerializedRtp {
    constructor(buffer) {
        this.buffer = buffer
    }

    serialize() {
        return this.buffer
    }
}

class FakeAnsweredConnection {
    constructor(timeline) {
        this.timeline = timeline
        this.onAudioRtp = new Subject()
        this.onVideoRtp = new Subject()
        this.onCallAnswered = new ReplaySubject(1)
        this.onCallEnded = new ReplaySubject(1)
        this.keyframeRequests = 0
        this.stopped = false
    }

    answer(sdp) {
        this.timeline.push('sdp_answer')
        this.onCallAnswered.next(sdp)
    }

    requestKeyFrame() {
        this.keyframeRequests++
        this.timeline.push('keyframe_request')
    }

    stop() {
        this.stopped = true
    }
}

test('real H264 RTP reaches ffmpeg decode and first clean adaptive candidate on current Burst path', { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ring-ki-forensic-'))
    t.after(() => rm(root, { recursive: true, force: true }))

    const fixture = await collectRealH264Rtp(root)
    const timeline = ['signaling_connected']
    const connection = new FakeAnsweredConnection(timeline)
    const session = new Build12StreamingSession({ id: 777, name: 'Forensic Camera' }, connection)
    t.after(() => session.stop())

    const capturePromise = session.captureJpegBurst({
        burstId: 'forensic-real-ffmpeg',
        frameCount: 3,
        outputDir: root,
        minSeparationMs: 50,
        observationWindowMs: 500,
        hardSafetyTimeoutMs: 5000
    })

    connection.answer(fixture.sdp)
    await sleep(250)
    timeline.push('rtp_start')

    for (const packet of fixture.packets) {
        connection.onVideoRtp.next(new SerializedRtp(packet))
        await sleep(1)
    }
    timeline.push('rtp_end')

    const result = await capturePromise
    timeline.push('burst_complete')

    assert.deepEqual(timeline.slice(0, 3), ['signaling_connected', 'sdp_answer', 'keyframe_request'])
    assert.ok(timeline.indexOf('rtp_start') > timeline.indexOf('keyframe_request'))
    assert.equal(result.frames.length, 3)
    assert.ok(result.candidateFramesEvaluated >= 3)
    assert.ok(result.firstCleanFrameAt, 'firstCleanFrameAt must be set by a real ffmpeg decoded/full/luma candidate')
    assert.equal(result.framePts.length, 3)
    assert.equal(result.framePtsTime.length, 3)
    assert.ok(result.rtpIntegrity.acceptedAccessUnits >= 1)
    assert.ok(result.rtpIntegrity.firstForwardedRtpTimestamp !== null)
    assert.ok(connection.keyframeRequests >= 1)
})
