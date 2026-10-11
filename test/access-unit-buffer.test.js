import test from 'node:test'
import assert from 'node:assert/strict'
import {
    AccessUnitBuffer,
    RTP_VIDEO_CLOCK_RATE,
    rtpTimestampDelta
} from '../lib/streaming/access-unit-buffer.js'

const FRAME_MS = 100
const FRAME_TICKS = (RTP_VIDEO_CLOCK_RATE * FRAME_MS) / 1000

function makeClock(start = 1_000_000) {
    let current = start
    return {
        now: () => current,
        advance(ms) { current += ms },
        set(ms) { current = ms }
    }
}

function unit(index, { keyframe = false, bytes = 100, baseTimestamp = 0 } = {}) {
    return {
        timestamp: (baseTimestamp + index * FRAME_TICKS) >>> 0,
        keyframe,
        packets: [Buffer.alloc(bytes, index & 0xff)]
    }
}

// Feeds one frame every FRAME_MS, with a keyframe every `gopFrames` frames.
function feed(buffer, clock, { frames, gopFrames = 10, startIndex = 0, bytes = 100, baseTimestamp = 0 }) {
    for (let i = 0; i < frames; i++) {
        const index = startIndex + i
        buffer.push({ ...unit(index, { keyframe: index % gopFrames === 0, bytes, baseTimestamp }), receivedAtMs: clock.now() })
        clock.advance(FRAME_MS)
    }
}

test('rtpTimestampDelta handles forward steps, backward steps and 32-bit wrap', () => {
    assert.equal(rtpTimestampDelta(1000, 4000), 3000)
    assert.equal(rtpTimestampDelta(4000, 1000), -3000)
    assert.equal(rtpTimestampDelta(2 ** 32 - 1000, 2000), 3000)
    assert.equal(rtpTimestampDelta(2000, 2 ** 32 - 1000), -3000)
    assert.equal(rtpTimestampDelta(5, 5), 0)
})

test('constructor rejects non-positive limits', () => {
    assert.throws(() => new AccessUnitBuffer({ maxDurationMs: 0 }), RangeError)
    assert.throws(() => new AccessUnitBuffer({ maxBytes: -1 }), RangeError)
})

test('push validates its input', () => {
    const buffer = new AccessUnitBuffer()
    assert.throws(() => buffer.push({ timestamp: -1, keyframe: true, packets: [Buffer.alloc(1)] }), TypeError)
    assert.throws(() => buffer.push({ timestamp: 2 ** 32, keyframe: true, packets: [Buffer.alloc(1)] }), TypeError)
    assert.throws(() => buffer.push({ timestamp: 1.5, keyframe: true, packets: [Buffer.alloc(1)] }), TypeError)
    assert.throws(() => buffer.push({ timestamp: 1, keyframe: true, packets: [] }), TypeError)
    assert.throws(() => buffer.push({ timestamp: 1, keyframe: true, packets: ['not a buffer'] }), TypeError)
    assert.equal(buffer.stats().unitCount, 0)
})

test('an empty buffer has nothing to extract and no age', () => {
    const buffer = new AccessUnitBuffer()
    assert.equal(buffer.extractAll(), null)
    assert.equal(buffer.extractFrom(0), null)
    assert.equal(buffer.newestAgeMs(), null)
    assert.equal(buffer.stats().oldestStartAgeMs, null)
})

test('units that arrive before the first keyframe are dropped and counted', () => {
    const clock = makeClock()
    const buffer = new AccessUnitBuffer({ now: clock.now })

    assert.equal(buffer.push({ ...unit(1), receivedAtMs: clock.now() }), false)
    assert.equal(buffer.push({ ...unit(2), receivedAtMs: clock.now() }), false)
    assert.equal(buffer.stats().droppedBeforeKeyframe, 2)
    assert.equal(buffer.stats().unitCount, 0)
    assert.equal(buffer.stats().awaitingKeyframe, true)

    assert.equal(buffer.push({ ...unit(3, { keyframe: true }), receivedAtMs: clock.now() }), true)
    assert.equal(buffer.stats().awaitingKeyframe, false)
    assert.equal(buffer.push({ ...unit(4), receivedAtMs: clock.now() }), true)
    assert.equal(buffer.stats().unitCount, 2)
})

test('extraction always starts at a keyframe and ends at the newest unit', () => {
    const clock = makeClock()
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 60_000 })
    feed(buffer, clock, { frames: 35, gopFrames: 10 })

    const all = buffer.extractAll()
    assert.equal(all.units[0].keyframe, true)
    assert.equal(all.units.length, 35)
    assert.equal(all.units.at(-1).timestamp, 34 * FRAME_TICKS)
    assert.equal(all.rtpSpanMs, 34 * FRAME_MS)
})

test('extractFrom picks the latest keyframe at or before the requested time', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 60_000 })
    feed(buffer, clock, { frames: 35, gopFrames: 10 }) // keyframes at 0, 1000, 2000, 3000 ms

    assert.equal(buffer.extractFrom(2500).startedAtMs, 2000)
    assert.equal(buffer.extractFrom(2000).startedAtMs, 2000, 'a keyframe exactly at the boundary is used')
    assert.equal(buffer.extractFrom(1999).startedAtMs, 1000)
    assert.equal(buffer.extractFrom(99_999).startedAtMs, 3000, 'a time newer than every keyframe uses the last one')
    assert.equal(buffer.extractFrom(-5).startedAtMs, 0, 'a time older than the retained window uses the oldest keyframe')
    for (const from of [0, 1500, 2500, 3200]) {
        assert.equal(buffer.extractFrom(from).units[0].keyframe, true)
    }
})

test('eviction removes whole GOPs and keeps a keyframe at or before the window start', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 3000 })
    feed(buffer, clock, { frames: 100, gopFrames: 10 }) // 10 s of video, keyframe every second

    const stats = buffer.stats()
    assert.ok(stats.evictedGops > 0)
    const all = buffer.extractAll()
    assert.equal(all.units[0].keyframe, true)

    const newestAt = all.endedAtMs
    assert.ok(all.startedAtMs <= newestAt - 3000, 'oldest retained keyframe covers the whole window')
    assert.ok(all.startedAtMs > newestAt - 3000 - 1000 - FRAME_MS, 'but not much more than one GOP beyond it')

    const unitCount = all.units.length
    assert.ok(unitCount >= 30 && unitCount <= 41, `retained ${unitCount} units`)
    // Every GOP that remains is complete: units are contiguous in RTP time.
    for (let i = 1; i < all.units.length; i++) {
        assert.equal(all.units[i].timestamp - all.units[i - 1].timestamp, FRAME_TICKS)
    }
})

test('with sparse keyframes the window is stretched to the keyframe instead of cutting a GOP', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 2000 })
    feed(buffer, clock, { frames: 80, gopFrames: 40 }) // 8 s of video, keyframe every 4 s

    const all = buffer.extractAll()
    assert.equal(all.units[0].keyframe, true)
    assert.ok(all.units.length >= 40, 'a GOP is never split to meet the duration limit')
})

test('the byte budget evicts the oldest GOPs first but never the only GOP', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 600_000, maxBytes: 3000 })
    feed(buffer, clock, { frames: 100, gopFrames: 10, bytes: 100 })

    assert.ok(buffer.stats().bytes <= 3000 + 1000, 'bounded by budget plus at most the newest GOP')
    assert.ok(buffer.stats().gopCount >= 1)
    assert.ok(buffer.stats().evictedGops > 0)
    assert.equal(buffer.extractAll().units[0].keyframe, true)

    const tiny = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 600_000, maxBytes: 150 })
    feed(tiny, clock, { frames: 10, gopFrames: 10, bytes: 100 })
    assert.equal(tiny.stats().gopCount, 1, 'a single oversized GOP is kept, it cannot be split')
    assert.equal(tiny.stats().unitCount, 10)
    assert.ok(tiny.stats().oversizedGops > 0)
})

test('byte accounting stays exact across evictions', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 2000 })
    feed(buffer, clock, { frames: 120, gopFrames: 10, bytes: 123 })

    const all = buffer.extractAll()
    const actual = all.units.reduce((total, u) => total + u.packets.reduce((sum, p) => sum + p.length, 0), 0)
    assert.equal(buffer.stats().bytes, actual)
    assert.equal(buffer.stats().unitCount, all.units.length)
})

test('multi-packet access units are counted by total packet size', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now })
    buffer.push({ timestamp: 0, keyframe: true, packets: [Buffer.alloc(1200), Buffer.alloc(1200), Buffer.alloc(300)], receivedAtMs: 0 })
    assert.equal(buffer.stats().bytes, 2700)
})

test('newestAgeMs exposes a stalled source', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now })
    feed(buffer, clock, { frames: 5, gopFrames: 10 })
    assert.equal(buffer.newestAgeMs(), FRAME_MS)
    clock.advance(4900)
    assert.equal(buffer.newestAgeMs(), 5000)
})

test('RTP timestamp wrap-around inside a GOP does not break the span calculation', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now, maxDurationMs: 60_000 })
    const base = 2 ** 32 - 5 * FRAME_TICKS
    feed(buffer, clock, { frames: 10, gopFrames: 100, baseTimestamp: base })

    const all = buffer.extractAll()
    assert.equal(all.units.length, 10)
    assert.equal(all.rtpSpanMs, 9 * FRAME_MS)
})

test('clear empties the buffer and requires a new keyframe again', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now })
    feed(buffer, clock, { frames: 20, gopFrames: 10 })
    buffer.clear()

    assert.equal(buffer.extractAll(), null)
    assert.equal(buffer.stats().bytes, 0)
    assert.equal(buffer.push({ ...unit(21), receivedAtMs: clock.now() }), false)
    assert.equal(buffer.push({ ...unit(22, { keyframe: true }), receivedAtMs: clock.now() }), true)
})

test('extracted units keep their original packets untouched', () => {
    const clock = makeClock(0)
    const buffer = new AccessUnitBuffer({ now: clock.now })
    const packets = [Buffer.from([1, 2, 3]), Buffer.from([4, 5])]
    buffer.push({ timestamp: 90, keyframe: true, packets, receivedAtMs: 0 })

    const [stored] = buffer.extractAll().units
    assert.deepEqual(stored.packets, packets)
    assert.equal(stored.bytes, 5)
    assert.equal(stored.timestamp, 90)
})
