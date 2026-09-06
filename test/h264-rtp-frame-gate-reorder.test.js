import test from 'node:test'
import assert from 'node:assert/strict'
import { H264RtpFrameGate } from '../lib/streaming/h264-rtp-frame-gate.js'

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

function makeFakeTimers() {
    let sequence = 0
    const callbacks = new Map()
    return {
        setTimer(callback) {
            const id = ++sequence
            callbacks.set(id, callback)
            return id
        },
        clearTimer(id) {
            callbacks.delete(id)
        },
        fireAll() {
            const pending = [...callbacks.entries()]
            callbacks.clear()
            for (const [, callback] of pending) callback()
        },
        get size() {
            return callbacks.size
        }
    }
}

const idrStart = Buffer.from([0x7c, 0x85, 0x01])
const idrMiddle = Buffer.from([0x7c, 0x05, 0x02])
const idrEnd = Buffer.from([0x7c, 0x45, 0x03])
const pStart = Buffer.from([0x7c, 0x81, 0x11])
const pEnd = Buffer.from([0x7c, 0x41, 0x12])

test('in-order IDR passes immediately and records RTP diagnostics', () => {
    const gate = new H264RtpFrameGate()
    assert.equal(gate.push(makeRtp({ sequenceNumber: 100, timestamp: 90000, payload: idrStart })), null)
    const result = gate.push(makeRtp({ sequenceNumber: 101, timestamp: 90000, marker: true, payload: idrEnd }))

    assert.equal(result.accepted, true)
    assert.deepEqual(result.packets.map(packet => packet.readUInt16BE(2)), [0, 1])

    const stats = gate.snapshotStats()
    assert.equal(stats.firstForwardedRtpTimestamp, 90000)
    assert.equal(stats.reorderedPackets, 0)
    assert.equal(stats.auDiagnostics.at(-1).finalizeReason, 'complete-in-order')
    assert.equal(stats.auDiagnostics.at(-1).rejectReason, null)
    assert.equal(stats.packetDiagnostics[0].fuAStart, true)
    assert.equal(stats.packetDiagnostics[1].fuAEnd, true)
})

test('marker/end before IDR start is buffered and finalized after reorder', () => {
    const gate = new H264RtpFrameGate()
    const markerFirst = gate.push(makeRtp({ sequenceNumber: 101, timestamp: 90000, marker: true, payload: idrEnd }))
    assert.equal(markerFirst, null)

    const pending = gate.snapshotStats()
    assert.equal(pending.pendingAccessUnits.length, 1)
    assert.equal(pending.pendingAccessUnits[0].markerSeen, true)

    const result = gate.push(makeRtp({ sequenceNumber: 100, timestamp: 90000, payload: idrStart }))
    assert.equal(result.accepted, true)
    assert.deepEqual(result.packets.map(packet => packet.readUInt16BE(2)), [0, 1])

    const stats = gate.snapshotStats()
    assert.equal(stats.reorderedPackets, 1)
    assert.equal(stats.auDiagnostics.at(-1).reorderedPacketCount, 1)
    assert.equal(stats.auDiagnostics.at(-1).finalizeReason, 'complete-after-reorder')
    assert.equal(stats.auDiagnostics.at(-1).missingSequenceRanges.length, 0)
    assert.deepEqual(stats.packetDiagnostics.map(item => item.arrivalOrder), [1, 2])
})

test('delayed middle fragment is held until the access unit is complete', () => {
    const gate = new H264RtpFrameGate()
    gate.push(makeRtp({ sequenceNumber: 200, timestamp: 180000, payload: idrStart }))
    assert.equal(gate.push(makeRtp({ sequenceNumber: 202, timestamp: 180000, marker: true, payload: idrEnd })), null)

    const pending = gate.snapshotStats().pendingAccessUnits[0]
    assert.deepEqual(pending.missingSequenceRanges, [{ start: 201, end: 201 }])

    const result = gate.push(makeRtp({ sequenceNumber: 201, timestamp: 180000, payload: idrMiddle }))
    assert.equal(result.accepted, true)
    assert.deepEqual(result.packets.map(packet => packet.readUInt16BE(2)), [0, 1, 2])
    assert.equal(gate.snapshotStats().auDiagnostics.at(-1).finalizeReason, 'complete-after-reorder')
})

test('duplicate RTP packet is ignored without corrupting the access unit', () => {
    const gate = new H264RtpFrameGate()
    const start = makeRtp({ sequenceNumber: 300, timestamp: 270000, payload: idrStart })
    gate.push(start)
    assert.equal(gate.push(start), null)
    const result = gate.push(makeRtp({ sequenceNumber: 301, timestamp: 270000, marker: true, payload: idrEnd }))

    assert.equal(result.accepted, true)
    assert.equal(result.packets.length, 2)
    const stats = gate.snapshotStats()
    assert.equal(stats.duplicatePackets, 1)
    assert.equal(stats.packetDiagnostics.filter(item => item.duplicate).length, 1)
})

test('RTP sequence wrap 65535 -> 0 is treated as contiguous, not reordered', () => {
    const gate = new H264RtpFrameGate()
    gate.push(makeRtp({ sequenceNumber: 65535, timestamp: 360000, payload: idrStart }))
    const result = gate.push(makeRtp({ sequenceNumber: 0, timestamp: 360000, marker: true, payload: idrEnd }))

    assert.equal(result.accepted, true)
    assert.deepEqual(result.packets.map(packet => packet.readUInt16BE(2)), [0, 1])
    assert.equal(gate.snapshotStats().reorderedPackets, 0)
})

test('permanent packet loss is rejected by the bounded reorder window without hanging', () => {
    const timers = makeFakeTimers()
    const gate = new H264RtpFrameGate({
        setTimer: callback => timers.setTimer(callback),
        clearTimer: id => timers.clearTimer(id)
    })

    gate.push(makeRtp({ sequenceNumber: 400, timestamp: 450000, payload: idrStart }))
    assert.equal(gate.push(makeRtp({ sequenceNumber: 402, timestamp: 450000, marker: true, payload: idrEnd })), null)
    assert.equal(timers.size, 1)

    timers.fireAll()
    const stats = gate.snapshotStats()
    assert.equal(stats.pendingAccessUnits.length, 0)
    assert.equal(stats.droppedAccessUnits, 1)
    assert.equal(stats.auDiagnostics.at(-1).rejectReason, 'reorder-timeout-missing-packets')
    assert.deepEqual(stats.auDiagnostics.at(-1).missingSequenceRanges, [{ start: 401, end: 401 }])
    assert.equal(stats.auDiagnostics.at(-1).boundedReorderExpiry, true)
})

test('a valid IDR after a timed-out broken access unit is accepted', () => {
    const timers = makeFakeTimers()
    const gate = new H264RtpFrameGate({
        setTimer: callback => timers.setTimer(callback),
        clearTimer: id => timers.clearTimer(id)
    })

    gate.push(makeRtp({ sequenceNumber: 500, timestamp: 540000, payload: idrStart }))
    gate.push(makeRtp({ sequenceNumber: 502, timestamp: 540000, marker: true, payload: idrEnd }))
    timers.fireAll()

    gate.push(makeRtp({ sequenceNumber: 510, timestamp: 630000, payload: idrStart }))
    const result = gate.push(makeRtp({ sequenceNumber: 511, timestamp: 630000, marker: true, payload: idrEnd }))
    assert.equal(result.accepted, true)
    assert.equal(result.keyframe, true)
    assert.equal(gate.snapshotStats().firstForwardedRtpTimestamp, 630000)
})

test('interleaved RTP timestamps remain buffered independently and drain in sequence order', () => {
    const gate = new H264RtpFrameGate()

    gate.push(makeRtp({ sequenceNumber: 100, timestamp: 90000, payload: idrStart }))
    assert.equal(gate.push(makeRtp({ sequenceNumber: 101, timestamp: 90000, marker: true, payload: idrEnd })).accepted, true)

    gate.push(makeRtp({ sequenceNumber: 102, timestamp: 93000, payload: pStart }))
    gate.push(makeRtp({ sequenceNumber: 104, timestamp: 96000, payload: pStart }))
    assert.equal(gate.push(makeRtp({ sequenceNumber: 105, timestamp: 96000, marker: true, payload: pEnd })), null)

    const result = gate.push(makeRtp({ sequenceNumber: 103, timestamp: 93000, marker: true, payload: pEnd }))
    assert.equal(result.accepted, true)
    assert.equal(result.accessUnits.length, 2)
    assert.deepEqual(result.accessUnits.map(unit => unit.timestamp), [93000, 96000])
    assert.deepEqual(result.packets.map(packet => packet.readUInt16BE(2)), [2, 3, 4, 5])
})

test('marker-less current AU expires, resyncs, and cannot pin expectedSequence forever', () => {
    const timers = makeFakeTimers()
    let keyframeRequests = 0
    const gate = new H264RtpFrameGate({
        requestKeyFrame: () => { keyframeRequests++ },
        setTimer: callback => timers.setTimer(callback),
        clearTimer: id => timers.clearTimer(id)
    })

    gate.push(makeRtp({ sequenceNumber: 1998, timestamp: 90000, payload: idrStart }))
    const first = gate.push(makeRtp({ sequenceNumber: 1999, timestamp: 90000, marker: true, payload: idrEnd }))
    assert.equal(first.accepted, true)
    assert.equal(gate.expectedSequence, 2000)

    gate.push(makeRtp({ sequenceNumber: 2000, timestamp: 93000, payload: pStart }))
    gate.push(makeRtp({ sequenceNumber: 2001, timestamp: 93000, payload: pEnd }))

    const pendingBeforeExpiry = gate.snapshotStats().pendingAccessUnits
    assert.equal(pendingBeforeExpiry.length, 1)
    assert.equal(pendingBeforeExpiry[0].startSequence, 2000)
    assert.equal(pendingBeforeExpiry[0].markerSeen, false)
    assert.equal(timers.size, 1, 'marker-less current AU must receive a bounded expiry timer')

    timers.fireAll()

    const afterExpiry = gate.snapshotStats()
    assert.equal(afterExpiry.pendingAccessUnits.length, 0, 'marker-less AU must not survive reorderWaitMs')
    assert.equal(afterExpiry.droppedAccessUnits, 1)
    assert.equal(afterExpiry.resyncs, 1)
    assert.equal(afterExpiry.auDiagnostics.at(-1).rejectReason, 'reorder-timeout-missing-marker')
    assert.equal(afterExpiry.auDiagnostics.at(-1).boundedReorderExpiry, true)
    assert.equal(gate.expectedSequence, null)
    assert.equal(keyframeRequests, 1)

    gate.push(makeRtp({ sequenceNumber: 2100, timestamp: 96000, payload: pStart }))
    assert.equal(gate.push(makeRtp({ sequenceNumber: 2101, timestamp: 96000, marker: true, payload: pEnd })), null)

    gate.push(makeRtp({ sequenceNumber: 2200, timestamp: 99000, payload: idrStart }))
    const recovered = gate.push(makeRtp({ sequenceNumber: 2201, timestamp: 99000, marker: true, payload: idrEnd }))
    assert.equal(recovered.accepted, true)
    assert.equal(recovered.keyframe, true)

    const finalStats = gate.snapshotStats()
    assert.equal(finalStats.auDiagnostics.at(-1).startSequence, 2200)
    assert.equal(gate.expectedSequence, 2202)
    assert.equal(finalStats.pendingAccessUnits.length, 0)
})
