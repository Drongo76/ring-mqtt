const RTP_FIXED_HEADER_BYTES = 12
const RTP_SEQUENCE_MODULO = 65536
const DEFAULT_MAX_ACCESS_UNIT_PACKETS = 4096

function nextSequence(sequenceNumber) {
    return (sequenceNumber + 1) & 0xffff
}

function previousSequence(sequenceNumber) {
    return (sequenceNumber - 1 + RTP_SEQUENCE_MODULO) & 0xffff
}

function sequenceDistance(start, end) {
    return (end - start + RTP_SEQUENCE_MODULO) & 0xffff
}

export function parseRtpPacket(packet) {
    const buffer = Buffer.isBuffer(packet) ? packet : Buffer.from(packet)
    if (buffer.length < RTP_FIXED_HEADER_BYTES || (buffer[0] >> 6) !== 2) return null

    const csrcCount = buffer[0] & 0x0f
    const hasExtension = Boolean(buffer[0] & 0x10)
    const hasPadding = Boolean(buffer[0] & 0x20)
    let payloadOffset = RTP_FIXED_HEADER_BYTES + (csrcCount * 4)
    if (payloadOffset > buffer.length) return null

    if (hasExtension) {
        if (payloadOffset + 4 > buffer.length) return null
        const extensionWords = buffer.readUInt16BE(payloadOffset + 2)
        payloadOffset += 4 + (extensionWords * 4)
        if (payloadOffset > buffer.length) return null
    }

    let payloadEnd = buffer.length
    if (hasPadding) {
        const paddingBytes = buffer[buffer.length - 1]
        if (!paddingBytes || payloadEnd - paddingBytes < payloadOffset) return null
        payloadEnd -= paddingBytes
    }
    if (payloadOffset >= payloadEnd) return null

    return {
        buffer,
        marker: Boolean(buffer[1] & 0x80),
        payloadType: buffer[1] & 0x7f,
        sequenceNumber: buffer.readUInt16BE(2),
        timestamp: buffer.readUInt32BE(4),
        ssrc: buffer.readUInt32BE(8),
        payload: buffer.subarray(payloadOffset, payloadEnd)
    }
}

export function payloadStartsH264Idr(payload) {
    if (!payload?.length) return false
    const nalType = payload[0] & 0x1f

    if (nalType === 5) return true

    // STAP-A: walk the aggregated NAL units and look for an IDR NAL.
    if (nalType === 24) {
        let offset = 1
        while (offset + 2 <= payload.length) {
            const nalSize = payload.readUInt16BE(offset)
            offset += 2
            if (!nalSize || offset + nalSize > payload.length) return false
            if ((payload[offset] & 0x1f) === 5) return true
            offset += nalSize
        }
        return false
    }

    // FU-A/FU-B: only the start fragment proves we have the beginning of an IDR NAL.
    if ((nalType === 28 || nalType === 29) && payload.length >= 2) {
        const fuHeader = payload[1]
        return Boolean(fuHeader & 0x80) && (fuHeader & 0x1f) === 5
    }

    return false
}

export class H264RtpFrameGate {
    constructor({ requestKeyFrame = () => {}, maxAccessUnitPackets = DEFAULT_MAX_ACCESS_UNIT_PACKETS } = {}) {
        this.requestKeyFrame = requestKeyFrame
        this.maxAccessUnitPackets = maxAccessUnitPackets
        this.frames = new Map()
        this.seenPackets = new Set()
        this.mediaSsrc = null
        this.expectedSequence = null
        this.outputSequence = 0
        this.synced = false
        this.stats = {
            acceptedAccessUnits: 0,
            droppedAccessUnits: 0,
            resyncs: 0,
            waitingForKeyframe: 0
        }
    }

    push(packet) {
        const parsed = parseRtpPacket(packet)
        if (!parsed) return null
        if (this.mediaSsrc !== null && parsed.ssrc !== this.mediaSsrc) return null

        const packetKey = `${parsed.ssrc}:${parsed.sequenceNumber}`
        if (this.seenPackets.has(packetKey)) return null
        this.seenPackets.add(packetKey)
        if (this.seenPackets.size > 8192) {
            this.seenPackets.delete(this.seenPackets.values().next().value)
        }

        const frameKey = `${parsed.ssrc}:${parsed.timestamp}`
        let frame = this.frames.get(frameKey)
        if (!frame) {
            frame = {
                ssrc: parsed.ssrc,
                timestamp: parsed.timestamp,
                packets: new Map(),
                markerSequence: null
            }
            this.frames.set(frameKey, frame)
        }
        frame.packets.set(parsed.sequenceNumber, parsed)

        if (!parsed.marker) return null
        frame.markerSequence = parsed.sequenceNumber
        this.frames.delete(frameKey)
        return this.finalize(frame)
    }

    finalize(frame) {
        if (this.synced) {
            const ordered = this.collect(frame, this.expectedSequence, frame.markerSequence)
            if (!ordered) return this.loseSync(frame.timestamp, 'incomplete-access-unit')

            this.expectedSequence = nextSequence(frame.markerSequence)
            this.stats.acceptedAccessUnits++
            return {
                accepted: true,
                timestamp: frame.timestamp,
                keyframe: ordered.some(packet => payloadStartsH264Idr(packet.payload)),
                packets: this.renumber(ordered)
            }
        }

        const keyframeStart = this.findKeyframeStart(frame)
        if (keyframeStart === null) {
            this.stats.waitingForKeyframe++
            return { accepted: false, timestamp: frame.timestamp, reason: 'waiting-keyframe', packets: [] }
        }

        let startSequence = keyframeStart
        for (let i = 0; i < 64; i++) {
            const previous = previousSequence(startSequence)
            if (!frame.packets.has(previous)) break
            startSequence = previous
        }

        const ordered = this.collect(frame, startSequence, frame.markerSequence)
        if (!ordered) return this.loseSync(frame.timestamp, 'incomplete-keyframe')

        this.mediaSsrc = frame.ssrc
        this.synced = true
        this.expectedSequence = nextSequence(frame.markerSequence)
        this.frames.clear()
        this.stats.acceptedAccessUnits++
        return {
            accepted: true,
            timestamp: frame.timestamp,
            keyframe: true,
            packets: this.renumber(ordered)
        }
    }

    findKeyframeStart(frame) {
        const candidates = []
        for (const [sequenceNumber, packet] of frame.packets) {
            if (!payloadStartsH264Idr(packet.payload)) continue
            const distance = sequenceDistance(sequenceNumber, frame.markerSequence)
            if (distance < this.maxAccessUnitPackets) candidates.push({ sequenceNumber, distance })
        }
        if (!candidates.length) return null
        candidates.sort((a, b) => b.distance - a.distance)
        return candidates[0].sequenceNumber
    }

    collect(frame, startSequence, markerSequence) {
        if (startSequence === null || markerSequence === null) return null
        const distance = sequenceDistance(startSequence, markerSequence)
        if (distance >= this.maxAccessUnitPackets) return null

        const ordered = []
        for (let offset = 0; offset <= distance; offset++) {
            const sequenceNumber = (startSequence + offset) & 0xffff
            const packet = frame.packets.get(sequenceNumber)
            if (!packet) return null
            ordered.push(packet)
        }
        return ordered
    }

    renumber(orderedPackets) {
        return orderedPackets.map(packet => {
            const output = Buffer.from(packet.buffer)
            output.writeUInt16BE(this.outputSequence, 2)
            this.outputSequence = nextSequence(this.outputSequence)
            return output
        })
    }

    loseSync(timestamp, reason) {
        const wasSynced = this.synced
        this.synced = false
        this.expectedSequence = null
        this.frames.clear()
        this.stats.droppedAccessUnits++
        if (wasSynced) this.stats.resyncs++
        try { this.requestKeyFrame() } catch {}
        return { accepted: false, timestamp, reason, packets: [] }
    }

    snapshotStats() {
        return { ...this.stats }
    }

    stop() {
        this.frames.clear()
        this.seenPackets.clear()
    }
}
