import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyframeTimeline } from '../lib/streaming/keyframe-timeline.js'
import { H264RtpFrameGate } from '../lib/streaming/h264-rtp-frame-gate.js'

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
    for (let index = 0; index < 10; index++) timeline.mark('x')
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
    assert.ok(events.some(event => /^\+0 au drop reason=test-reject idrStart=no$/.test(event)), events.join('\n'))
    assert.ok(events.some(event => /^\+300 au drop reason=test-reject idrStart=no$/.test(event)), events.join('\n'))
    assert.equal(events.at(-1), '+2300 au ok IDR pkts=2')
})

test('gate works unchanged without a timeline', () => {
    const gate = new H264RtpFrameGate()
    gate.push(makeRtp({ sequenceNumber: 1, timestamp: 90000, payload: idrStart }))
    const result = gate.push(makeRtp({ sequenceNumber: 2, timestamp: 90000, marker: true, payload: idrEnd }))
    assert.equal(result.accepted, true)
})
