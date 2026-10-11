// Bounded in-memory history of complete H.264 access units from ONE media source.
// A new source (a new WebRTC session) gets its own buffer, because a decoder cannot be fed across
// a change of source. Gaps inside a source are already handled by H264RtpFrameGate, which only
// resumes output at a keyframe, so a keyframe always starts a fresh GOP here.
//
// The buffer never decodes anything. It keeps the RTP packets of access units that were already
// validated by H264RtpFrameGate, grouped into GOPs (a keyframe followed by its dependent frames),
// so a decoder can later be started from a keyframe at or before any point inside the retained
// window. Eviction always removes whole GOPs, because a partial GOP cannot be decoded.

export const RTP_VIDEO_CLOCK_RATE = 90000
export const DEFAULT_MAX_DURATION_MS = 8000
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

const RTP_TIMESTAMP_MODULO = 2 ** 32

// Signed difference between two 32-bit RTP timestamps, tolerant of wrap-around.
export function rtpTimestampDelta(from, to) {
    const delta = ((to - from) % RTP_TIMESTAMP_MODULO + RTP_TIMESTAMP_MODULO) % RTP_TIMESTAMP_MODULO
    return delta > RTP_TIMESTAMP_MODULO / 2 ? delta - RTP_TIMESTAMP_MODULO : delta
}

function packetBytes(packets) {
    let total = 0
    for (const packet of packets) total += packet.length
    return total
}

export class AccessUnitBuffer {
    constructor({ maxDurationMs = DEFAULT_MAX_DURATION_MS, maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
        if (!(maxDurationMs > 0)) throw new RangeError('maxDurationMs must be positive')
        if (!(maxBytes > 0)) throw new RangeError('maxBytes must be positive')
        this.maxDurationMs = maxDurationMs
        this.maxBytes = maxBytes
        this.now = now
        this.gops = []
        this.bytes = 0
        this.awaitingKeyframe = true
        this.counters = {
            evictedGops: 0,
            droppedBeforeKeyframe: 0,
            oversizedGops: 0
        }
    }

    // Accepts one complete access unit. Returns true when it was stored.
    push({ timestamp, keyframe, packets, receivedAtMs = this.now() }) {
        if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= RTP_TIMESTAMP_MODULO) {
            throw new TypeError('access unit timestamp must be a 32-bit unsigned integer')
        }
        if (!Array.isArray(packets) || packets.length === 0 || !packets.every(Buffer.isBuffer)) {
            throw new TypeError('access unit packets must be a non-empty array of Buffers')
        }

        if (keyframe) {
            this.awaitingKeyframe = false
            this.gops.push({ startedAtMs: receivedAtMs, units: [], bytes: 0 })
        } else if (this.awaitingKeyframe || this.gops.length === 0) {
            this.counters.droppedBeforeKeyframe++
            return false
        }

        const gop = this.gops[this.gops.length - 1]
        const bytes = packetBytes(packets)
        gop.units.push({ timestamp, keyframe: Boolean(keyframe), packets, receivedAtMs, bytes })
        gop.bytes += bytes
        this.bytes += bytes
        this.evict(receivedAtMs)
        return true
    }

    evict(newestAtMs) {
        while (this.gops.length > 1) {
            const oldest = this.gops[0]
            const next = this.gops[1]
            const overBudget = this.bytes > this.maxBytes
            // The oldest GOP is only needed while the next keyframe is still inside the window:
            // once the next GOP starts at or before the window start, it covers the whole window.
            const coveredByNext = next.startedAtMs <= newestAtMs - this.maxDurationMs
            if (!overBudget && !coveredByNext) break
            this.gops.shift()
            this.bytes -= oldest.bytes
            this.counters.evictedGops++
        }
        if (this.gops.length === 1 && this.bytes > this.maxBytes) this.counters.oversizedGops++
    }

    get newestReceivedAtMs() {
        const last = this.gops[this.gops.length - 1]
        return last ? last.units[last.units.length - 1].receivedAtMs : null
    }

    // Age of the newest unit, or null when empty. A large value means the source stalled.
    newestAgeMs() {
        const newest = this.newestReceivedAtMs
        return newest === null ? null : this.now() - newest
    }

    // Returns units starting at the latest keyframe that began at or before `fromMs`
    // (or the oldest retained keyframe if none is that old) through the newest unit.
    // The returned units are shared with the buffer and must be treated as read-only.
    extractFrom(fromMs) {
        if (this.gops.length === 0) return null
        let startIndex = 0
        for (let i = 0; i < this.gops.length; i++) {
            if (this.gops[i].startedAtMs <= fromMs) startIndex = i
            else break
        }
        const units = this.gops.slice(startIndex).flatMap(gop => gop.units)
        return {
            units,
            startedAtMs: this.gops[startIndex].startedAtMs,
            endedAtMs: units[units.length - 1].receivedAtMs,
            rtpSpanMs: Math.round(rtpTimestampDelta(units[0].timestamp, units[units.length - 1].timestamp) * 1000 / RTP_VIDEO_CLOCK_RATE)
        }
    }

    extractAll() {
        return this.extractFrom(Number.NEGATIVE_INFINITY)
    }

    clear() {
        this.gops = []
        this.bytes = 0
        this.awaitingKeyframe = true
    }

    stats() {
        const newest = this.newestReceivedAtMs
        return {
            gopCount: this.gops.length,
            unitCount: this.gops.reduce((total, gop) => total + gop.units.length, 0),
            bytes: this.bytes,
            oldestStartAgeMs: this.gops.length ? this.now() - this.gops[0].startedAtMs : null,
            newestAgeMs: newest === null ? null : this.now() - newest,
            awaitingKeyframe: this.awaitingKeyframe,
            ...this.counters
        }
    }
}
