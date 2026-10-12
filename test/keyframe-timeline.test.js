import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyframeTimeline } from '../lib/streaming/keyframe-timeline.js'
import { H264RtpFrameGate, describeAccessUnitNalTypes } from '../lib/streaming/h264-rtp-frame-gate.js'

function clock(start = 1000) {
    let value = start
    return { now: () => value, advance: ms => { value += ms } }
}

function makeRtp({ sequenceNumber, timestamp, marker = false, payload, ssrc = 0x12345678 }) {
    const packet = Buffer.alloc(12 + payload.length)
    packet[0] = 0x80
    packet[1] = 96 | (marker ? 0x80 : 0)
    packet.writeUInt16BE(sequenceNumber & 0xffff, 2)
    packet.writeUInt32BE(timestamp >>> 0, 4)
    packet.writeUInt32BE(ssrc >>> 0, 8)
    payload.copy(packet, 12)
    return packet
}

const idrStart = Buffer.from([0x7c, 0x85, 0x01])
const idrEnd = Buffer.from([0x7c, 0x45, 0x03])
const pStart = Buffer.from([0x7c, 0x81, 0x11])
const pEnd = Buffer.from([0x7c, 0x41, 0x12])

test('timeline timestamps events relative to the burst start', () => {
    const time = clock(5000)
    const timeline = new KeyframeTimeline({ now: time.now, startedAtMs: 4200 })
    timeline.keyframeRequested('burst-start')
    time.advance(850)
    timeline.pliSent({ ok: true })
    timeline.pliSent({ ok: false, error: 'closed' })
    assert.deepEqual(timeline.snapshot().events, [
        '+800 keyframe requested (burst-start)',
        '+1650 PLI sent',
        '+1650 PLI failed closed'
    ])
})

test('only the first packets are listed, the rest are counted', () => {
    const timeline = new KeyframeTimeline({ now: clock().now, startedAtMs: 1000, maxPackets: 2 })
    for (let sequenceNumber = 1; sequenceNumber <= 5; sequenceNumber++) {
        timeline.packet({ sequenceNumber, nalType: 28, fuAStart: sequenceNumber === 1, fuAEnd: false, marker: false, duplicate: false })
    }
    const snapshot = timeline.snapshot()
    assert.equal(snapshot.packetsSeen, 5)
    assert.equal(snapshot.events.length, 2)
    assert.equal(snapshot.events[0], '+0 pkt seq=1 nal=28 S')
})

test('timeline is bounded and reports truncation', () => {
    const timeline = new KeyframeTimeline({ now: clock().now, startedAtMs: 1000, maxEvents: 3 })
    for (let index = 0; index < 10; index++) timeline.mark(`x${index}`)
    const snapshot = timeline.snapshot()
    assert.equal(snapshot.events.length, 3)
    assert.equal(snapshot.truncated, true)
})

test('gate records a missed IDR start, dropped P frames and the first accepted IDR', () => {
    const time = clock(1000)
    const timeline = new KeyframeTimeline({ now: time.now, startedAtMs: 1000, maxPackets: 0 })
    const gate = new H264RtpFrameGate({ timeline, setTimer: () => 0, clearTimer: () => {} })

    // First IDR arrives without its start fragment: it can never become a keyframe start.
    gate.push(makeRtp({ sequenceNumber: 10, timestamp: 90000, marker: true, payload: idrEnd }))
    for (const frame of [...gate.frames.values()]) gate.rejectFrame(frame, 'test-reject')
    time.advance(300)
    // A complete P frame arrives while still waiting for a keyframe.
    gate.push(makeRtp({ sequenceNumber: 11, timestamp: 93000, payload: pStart }))
    gate.push(makeRtp({ sequenceNumber: 12, timestamp: 93000, marker: true, payload: pEnd }))
    for (const frame of [...gate.frames.values()]) gate.rejectFrame(frame, 'test-reject')
    time.advance(2000)
    // The next IDR is complete.
    gate.push(makeRtp({ sequenceNumber: 13, timestamp: 270000, payload: idrStart }))
    const result = gate.push(makeRtp({ sequenceNumber: 14, timestamp: 270000, marker: true, payload: idrEnd }))
    assert.equal(result.accepted, true)

    const events = timeline.snapshot().events
    assert.ok(events.some(event => event === '+0 au drop reason=test-reject idrStart=no x2 until +300'), events.join('\n'))
    assert.equal(events.at(-1), '+2300 au ok IDR pkts=2')
})

test('gate works unchanged without a timeline', () => {
    const gate = new H264RtpFrameGate()
    gate.push(makeRtp({ sequenceNumber: 1, timestamp: 90000, payload: idrStart }))
    const result = gate.push(makeRtp({ sequenceNumber: 2, timestamp: 90000, marker: true, payload: idrEnd }))
    assert.equal(result.accepted, true)
})

test('identical consecutive events are folded with count and end time', () => {
    const time = clock(0)
    const timeline = new KeyframeTimeline({ now: time.now, startedAtMs: 0, maxEvents: 2 })
    for (let index = 0; index < 5; index++) {
        timeline.accessUnit({ accepted: false, reason: 'no-key', hasKeyframeStart: false, packets: 3 })
        time.advance(50)
    }
    timeline.mark('resync')
    timeline.mark('after')
    assert.deepEqual(timeline.snapshot().events, ['+0 au drop reason=no-key idrStart=no x5 until +200', '+250 resync'])
    assert.equal(timeline.snapshot().truncated, true)
})

test('dropped keyframe candidates report packet count, missing packets and marker', () => {
    const time = clock(1000)
    const timeline = new KeyframeTimeline({ now: time.now, startedAtMs: 1000, maxPackets: 0 })
    const gate = new H264RtpFrameGate({ timeline, setTimer: () => 0, clearTimer: () => {} })
    gate.push(makeRtp({ sequenceNumber: 20, timestamp: 90000, payload: idrStart }))
    gate.push(makeRtp({ sequenceNumber: 22, timestamp: 90000, marker: true, payload: idrEnd }))
    for (const frame of [...gate.frames.values()]) gate.rejectFrame(frame, 'reorder-timeout-missing-packets')
    assert.deepEqual(timeline.snapshot().events, ['+0 au drop reason=reorder-timeout-missing-packets idrStart=yes pkts=2 missing=1 marker=yes nals=5'])
})

test('duplicate packets are counted per 500 ms bucket even beyond the listed packets', () => {
    const time = clock(0)
    const timeline = new KeyframeTimeline({ now: time.now, startedAtMs: 0, maxPackets: 0 })
    timeline.packet({ sequenceNumber: 1, duplicate: true })
    timeline.packet({ sequenceNumber: 2, duplicate: true })
    time.advance(700)
    timeline.packet({ sequenceNumber: 3, duplicate: true })
    timeline.packet({ sequenceNumber: 4, duplicate: false })
    assert.deepEqual(timeline.snapshot().duplicatesPer500ms, { 0: 2, 500: 1 })
})

test('access unit NAL types cover single NALs, STAP-A members and FU-A starts only', () => {
    const sps = Buffer.from([0x67, 0x42])
    const pps = Buffer.from([0x68, 0xce])
    const stapA = Buffer.concat([Buffer.from([0x78]), Buffer.from([0, sps.length]), sps, Buffer.from([0, pps.length]), pps])
    const fuStartIdr = Buffer.from([0x7c, 0x85, 0x01])
    const fuMiddle = Buffer.from([0x7c, 0x05, 0x02])
    const fuStartNonIdr = Buffer.from([0x7c, 0x81, 0x01])
    const sei = Buffer.from([0x06, 0x05])
    const packets = payloads => payloads.map(payload => ({ payload }))
    assert.deepEqual(describeAccessUnitNalTypes(packets([stapA, fuStartIdr, fuMiddle])), [5, 7, 8])
    assert.deepEqual(describeAccessUnitNalTypes(packets([sei, fuStartNonIdr, fuMiddle])), [1, 6])
    assert.deepEqual(describeAccessUnitNalTypes(packets([fuMiddle])), [])
})

test('dropped large access units report which NAL types they carried', () => {
    const timeline = new KeyframeTimeline({ now: clock().now, startedAtMs: 1000 })
    timeline.accessUnit({ accepted: false, reason: 'reorder-timeout-no-keyframe-start', hasKeyframeStart: false, packets: 112, missing: 0, markerSeen: true, nalTypes: [1, 6] })
    assert.deepEqual(timeline.snapshot().events, ['+0 au drop reason=reorder-timeout-no-keyframe-start idrStart=no pkts=112 missing=0 marker=yes nals=1,6'])
})
