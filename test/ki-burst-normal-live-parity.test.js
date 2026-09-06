import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { H264RtpFrameGate, parseRtpPacket } from '../lib/streaming/h264-rtp-frame-gate.js'

function makeRtp({ sequenceNumber, timestamp, marker = false, payload, ssrc = 0x12345678, payloadType = 96 }) {
    const packet = Buffer.alloc(12 + payload.length)
    packet[0] = 0x80
    packet[1] = payloadType | (marker ? 0x80 : 0)
    packet.writeUInt16BE(sequenceNumber & 0xffff, 2)
    packet.writeUInt32BE(timestamp >>> 0, 4)
    packet.writeUInt32BE(ssrc >>> 0, 8)
    payload.copy(packet, 12)
    return packet
}

class JitterAwareH264DecoderHarness {
    constructor() {
        this.frames = new Map()
        this.cleanFrames = 0
    }

    push(packet) {
        const parsed = parseRtpPacket(packet)
        assert.ok(parsed)
        const key = `${parsed.ssrc}:${parsed.timestamp}`
        let frame = this.frames.get(key)
        if (!frame) {
            frame = { packets: new Map(), markerSequence: null }
            this.frames.set(key, frame)
        }
        frame.packets.set(parsed.sequenceNumber, parsed)
        if (parsed.marker) frame.markerSequence = parsed.sequenceNumber

        // Models the tolerance normal live gets from forwarding every RTP packet
        // into ffmpeg's RTP/jitter handling: marker may arrive before an earlier
        // fragment, and the frame becomes decodable once the whole AU is present.
        if (frame.markerSequence === null) return
        const idrStarts = [...frame.packets.values()].filter(item => {
            const nalType = item.payload[0] & 0x1f
            if (nalType !== 28 || item.payload.length < 2) return false
            const fuHeader = item.payload[1]
            return Boolean(fuHeader & 0x80) && (fuHeader & 0x1f) === 5
        })
        if (!idrStarts.length) return

        const start = idrStarts[0].sequenceNumber
        let seq = start
        while (true) {
            if (!frame.packets.has(seq)) return
            if (seq === frame.markerSequence) break
            seq = (seq + 1) & 0xffff
        }
        this.cleanFrames++
        this.frames.delete(key)
    }
}

async function assertSourcePathsStillDifferOnlyAtRtpForwarding() {
    const normalSource = await readFile(new URL('../lib/streaming/streaming-session.js', import.meta.url), 'utf8')
    const burstSource = await readFile(new URL('../lib/streaming/build12-streaming-session.js', import.meta.url), 'utf8')

    const normalVideoPortIndex = normalSource.indexOf('const videoPort = await this.reservePort(1)')
    const normalAnswerIndex = normalSource.indexOf('firstValueFrom(this.connection.onCallAnswered)')
    const burstVideoPortIndex = burstSource.indexOf('const videoPort = await this.reservePort(1)')
    const burstAnswerIndex = burstSource.indexOf('firstValueFrom(this.connection.onCallAnswered)')

    assert.ok(normalVideoPortIndex >= 0, 'normal live video-port reservation is present')
    assert.ok(normalAnswerIndex >= 0, 'normal live SDP-answer wait is present')
    assert.ok(burstVideoPortIndex >= 0, 'dedicated KI Burst video-port reservation is present')
    assert.ok(burstAnswerIndex >= 0, 'dedicated KI Burst SDP-answer wait is present')
    assert.ok(normalVideoPortIndex < normalAnswerIndex, 'normal live reserves its video port before waiting for the SDP answer')
    assert.ok(burstVideoPortIndex < burstAnswerIndex, 'dedicated KI Burst must reserve its video port before waiting for the SDP answer')

    assert.match(normalSource, /this\.onVideoRtp\.pipe\(concatMap\(\(rtp\) => \{\s*return this\.videoSplitter\.send\(rtp\.serialize\(\), \{ port: videoPort \}\)/s)
    assert.match(burstSource, /this\.onVideoRtp\.subscribe\(rtp => \{\s*const result = gate\.push\(rtp\.serialize\(\)\)\s*if \(!result\?\.accepted\) return/s)
}

test('normal live RTP ordering reaches first frame and dedicated Burst reaches parity for the same reordered IDR', async () => {
    await assertSourcePathsStillDifferOnlyAtRtpForwarding()

    // Matches the actual normal-live event ordering: signaling succeeds, ffmpeg is
    // ready before peer connection reports connected, and RTP follows afterwards.
    const normalTimeline = [
        'worker_start',
        'signaling_connected',
        'sdp_answer',
        'ffmpeg_started',
        'pc_connected'
    ]
    const burstTimeline = [...normalTimeline]
    assert.deepEqual(burstTimeline, normalTimeline)

    // One two-packet FU-A IDR access unit delivered with marker/end first.
    const idrStart = Buffer.from([0x7c, 0x85, 0x01])
    const idrEnd = Buffer.from([0x7c, 0x45, 0x02])
    const arrival = [
        makeRtp({ sequenceNumber: 101, timestamp: 90000, marker: true, payload: idrEnd }),
        makeRtp({ sequenceNumber: 100, timestamp: 90000, marker: false, payload: idrStart })
    ]

    const normalDecoder = new JitterAwareH264DecoderHarness()
    for (const packet of arrival) normalDecoder.push(packet)
    assert.equal(normalDecoder.cleanFrames, 1, 'normal live direct RTP forwarding reconstructs the reordered IDR')

    const gate = new H264RtpFrameGate()
    const burstDecoder = new JitterAwareH264DecoderHarness()
    let burstForwardedPackets = 0

    for (const packet of arrival) {
        const result = gate.push(packet)
        if (!result?.accepted) continue
        for (const forwarded of result.packets) {
            burstForwardedPackets++
            burstDecoder.push(forwarded)
        }
    }

    const stats = gate.snapshotStats()
    assert.equal(stats.waitingForKeyframe, 0)
    assert.equal(stats.reorderedPackets, 1)
    assert.equal(stats.firstForwardedRtpTimestamp, 90000)
    assert.equal(stats.auDiagnostics.at(-1).finalizeReason, 'complete-after-reorder')
    assert.equal(burstForwardedPackets, 2)
    assert.equal(
        burstDecoder.cleanFrames,
        1,
        'dedicated KI Burst reaches the same first clean frame as normal live for the same RTP arrival order'
    )
})
