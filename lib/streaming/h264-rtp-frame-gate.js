const RTP_FIXED_HEADER_BYTES = 12
const RTP_SEQUENCE_MODULO = 65536
const RTP_HALF_SEQUENCE_RANGE = RTP_SEQUENCE_MODULO / 2
const DEFAULT_MAX_ACCESS_UNIT_PACKETS = 4096
const DEFAULT_REORDER_WAIT_MS = 250
const DEFAULT_MAX_REORDER_PACKETS = 64
const DEFAULT_MAX_PENDING_FRAMES = 16
const MAX_PACKET_DIAGNOSTICS = 256
const MAX_AU_DIAGNOSTICS = 64

function nextSequence(sequenceNumber) {
    return (sequenceNumber + 1) & 0xffff
}

function previousSequence(sequenceNumber) {
    return (sequenceNumber - 1 + RTP_SEQUENCE_MODULO) & 0xffff
}

function sequenceDistance(start, end) {
    return (end - start + RTP_SEQUENCE_MODULO) & 0xffff
}

function appendBounded(array, value, limit) {
    array.push(value)
    if (array.length > limit) array.splice(0, array.length - limit)
}

function inspectH264Payload(payload) {
    if (!payload?.length) {
        return { nalType: null, fuAStart: false, fuAEnd: false }
    }
    const nalType = payload[0] & 0x1f
    if (nalType === 28 && payload.length >= 2) {
        const fuHeader = payload[1]
        return {
            nalType,
            fuAStart: Boolean(fuHeader & 0x80),
            fuAEnd: Boolean(fuHeader & 0x40)
        }
    }
    return { nalType, fuAStart: false, fuAEnd: false }
}

function payloadStartsH264AccessUnit(payload) {
    if (!payload?.length) return false
    const nalType = payload[0] & 0x1f
    if (nalType >= 1 && nalType <= 24) return true
    if ((nalType === 28 || nalType === 29) && payload.length >= 2) {
        return Boolean(payload[1] & 0x80)
    }
    return false
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
    constructor({
        requestKeyFrame = () => {},
        maxAccessUnitPackets = DEFAULT_MAX_ACCESS_UNIT_PACKETS,
        reorderWaitMs = DEFAULT_REORDER_WAIT_MS,
        maxReorderPackets = DEFAULT_MAX_REORDER_PACKETS,
        maxPendingFrames = DEFAULT_MAX_PENDING_FRAMES,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    } = {}) {
        this.requestKeyFrame = requestKeyFrame
        this.maxAccessUnitPackets = maxAccessUnitPackets
        this.reorderWaitMs = reorderWaitMs
        this.maxReorderPackets = maxReorderPackets
        this.maxPendingFrames = maxPendingFrames
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.frames = new Map()
        this.seenPackets = new Set()
        this.mediaSsrc = null
        this.expectedSequence = null
        this.outputSequence = 0
        this.synced = false
        this.arrivalOrder = 0
        this.lastArrivalSequenceBySsrc = new Map()
        this.packetDiagnostics = []
        this.auDiagnostics = []
        this.stats = {
            acceptedAccessUnits: 0,
            droppedAccessUnits: 0,
            resyncs: 0,
            waitingForKeyframe: 0,
            reorderedPackets: 0,
            duplicatePackets: 0,
            firstForwardedRtpTimestamp: null
        }
    }

    push(packet) {
        const parsed = parseRtpPacket(packet)
        if (!parsed) return null
        if (this.mediaSsrc !== null && parsed.ssrc !== this.mediaSsrc) return null

        parsed.arrivalOrder = ++this.arrivalOrder
        const packetKey = `${parsed.ssrc}:${parsed.sequenceNumber}`
        const duplicate = this.seenPackets.has(packetKey)
        const previousArrivalSequence = this.lastArrivalSequenceBySsrc.get(parsed.ssrc)
        const reordered = !duplicate && previousArrivalSequence !== undefined &&
            sequenceDistance(previousArrivalSequence, parsed.sequenceNumber) > RTP_HALF_SEQUENCE_RANGE
        const h264 = inspectH264Payload(parsed.payload)

        appendBounded(this.packetDiagnostics, {
            arrivalOrder: parsed.arrivalOrder,
            timestamp: parsed.timestamp,
            sequenceNumber: parsed.sequenceNumber,
            marker: parsed.marker,
            fuAStart: h264.fuAStart,
            fuAEnd: h264.fuAEnd,
            reordered,
            duplicate
        }, MAX_PACKET_DIAGNOSTICS)

        if (duplicate) {
            this.stats.duplicatePackets++
            return null
        }

        this.seenPackets.add(packetKey)
        if (this.seenPackets.size > 8192) {
            this.seenPackets.delete(this.seenPackets.values().next().value)
        }
        this.lastArrivalSequenceBySsrc.set(parsed.ssrc, parsed.sequenceNumber)
        if (reordered) this.stats.reorderedPackets++

        const frameKey = `${parsed.ssrc}:${parsed.timestamp}`
        let frame = this.frames.get(frameKey)
        if (!frame) {
            frame = {
                key: frameKey,
                ssrc: parsed.ssrc,
                timestamp: parsed.timestamp,
                packets: new Map(),
                markerSeen: false,
                markerSequence: null,
                markerArrivalOrder: null,
                firstArrivalOrder: parsed.arrivalOrder,
                lastArrivalOrder: parsed.arrivalOrder,
                reorderedPacketCount: 0,
                timer: null
            }
            this.frames.set(frameKey, frame)
        }
        frame.packets.set(parsed.sequenceNumber, parsed)
        frame.lastArrivalOrder = parsed.arrivalOrder
        if (reordered) frame.reorderedPacketCount++

        if (parsed.marker) {
            frame.markerSeen = true
            frame.markerSequence = parsed.sequenceNumber
            frame.markerArrivalOrder = parsed.arrivalOrder
        }

        let accepted = this.drainReadyFrames()
        if (accepted.length) return this.combineAccepted(accepted)

        if (frame.markerSeen && this.frames.has(frame.key)) this.ensureReorderTimer(frame)
        this.expireByArrivalWindow()
        this.evictExcessPendingFrames()

        accepted = this.drainReadyFrames()
        return accepted.length ? this.combineAccepted(accepted) : null
    }

    ensureReorderTimer(frame) {
        if (frame.timer || !frame.markerSeen || !this.frames.has(frame.key)) return
        frame.timer = this.setTimer(() => {
            frame.timer = null
            if (!this.frames.has(frame.key)) return
            this.rejectFrame(frame, this.getTimeoutRejectReason(frame), { fromTimeout: true })
        }, this.reorderWaitMs)
    }

    expireByArrivalWindow() {
        for (const frame of [...this.frames.values()]) {
            if (!frame.markerSeen || frame.markerArrivalOrder === null) continue
            if ((this.arrivalOrder - frame.markerArrivalOrder) < this.maxReorderPackets) continue
            this.rejectFrame(frame, this.getTimeoutRejectReason(frame), { fromTimeout: true })
        }
    }

    evictExcessPendingFrames() {
        if (this.frames.size <= this.maxPendingFrames) return
        const current = this.synced ? this.currentSyncedFrame() : null
        const candidates = [...this.frames.values()]
            .filter(frame => frame !== current)
            .sort((a, b) => a.firstArrivalOrder - b.firstArrivalOrder)
        while (this.frames.size > this.maxPendingFrames && candidates.length) {
            this.rejectFrame(candidates.shift(), 'pending-window-overflow', { fromTimeout: true })
        }
    }

    drainReadyFrames() {
        const accepted = []
        while (true) {
            if (this.synced) {
                const frame = this.currentSyncedFrame()
                if (!frame || !frame.markerSeen) break
                const result = this.inspectSyncedFrame(frame)
                if (result.rejectReason) {
                    this.rejectFrame(frame, result.rejectReason)
                    continue
                }
                if (!result.ready) break
                accepted.push(this.acceptFrame(frame, result))
                continue
            }

            const frames = [...this.frames.values()]
                .filter(frame => frame.markerSeen)
                .sort((a, b) => a.firstArrivalOrder - b.firstArrivalOrder)
            let progressed = false
            for (const frame of frames) {
                const result = this.inspectUnsyncedFrame(frame)
                if (result.rejectReason) {
                    this.rejectFrame(frame, result.rejectReason)
                    progressed = true
                    break
                }
                if (!result.ready) continue
                accepted.push(this.acceptFrame(frame, result))
                this.discardSupersededFrames(frame.key)
                progressed = true
                break
            }
            if (!progressed) break
        }
        return accepted
    }

    currentSyncedFrame() {
        if (!this.synced || this.expectedSequence === null) return null
        const containingExpected = [...this.frames.values()]
            .filter(frame => frame.ssrc === this.mediaSsrc && frame.packets.has(this.expectedSequence))
            .sort((a, b) => a.firstArrivalOrder - b.firstArrivalOrder)
        if (containingExpected.length) return containingExpected[0]

        const withMarker = [...this.frames.values()]
            .filter(frame => frame.ssrc === this.mediaSsrc && frame.markerSeen)
            .map(frame => ({ frame, distance: sequenceDistance(this.expectedSequence, frame.markerSequence) }))
            .filter(item => item.distance < this.maxAccessUnitPackets)
            .sort((a, b) => a.distance - b.distance || a.frame.firstArrivalOrder - b.frame.firstArrivalOrder)
        return withMarker[0]?.frame || null
    }

    inspectSyncedFrame(frame) {
        if (!frame.markerSeen || this.expectedSequence === null) return { ready: false }
        const distance = sequenceDistance(this.expectedSequence, frame.markerSequence)
        if (distance >= this.maxAccessUnitPackets) return { ready: false }

        const startSequence = this.expectedSequence
        const startPacket = frame.packets.get(startSequence)
        if (!startPacket) {
            return {
                ready: false,
                startSequence,
                missingSequenceRanges: this.findMissingSequenceRanges(frame, startSequence, frame.markerSequence)
            }
        }
        if (!payloadStartsH264AccessUnit(startPacket.payload)) {
            return { ready: false, rejectReason: 'invalid-access-unit-start', startSequence }
        }

        const missingSequenceRanges = this.findMissingSequenceRanges(frame, startSequence, frame.markerSequence)
        if (missingSequenceRanges.length) return { ready: false, startSequence, missingSequenceRanges }

        const ordered = this.collect(frame, startSequence, frame.markerSequence)
        if (!ordered) return { ready: false, startSequence, missingSequenceRanges }
        return { ready: true, startSequence, ordered, missingSequenceRanges: [] }
    }

    inspectUnsyncedFrame(frame) {
        if (!frame.markerSeen) return { ready: false }
        const keyframeStart = this.findKeyframeStart(frame)
        if (keyframeStart === null) return { ready: false }

        let startSequence = keyframeStart
        let cursor = keyframeStart
        for (let i = 0; i < 64; i++) {
            const previous = previousSequence(cursor)
            const packet = frame.packets.get(previous)
            if (!packet) break
            cursor = previous
            if (payloadStartsH264AccessUnit(packet.payload)) startSequence = previous
        }

        const startPacket = frame.packets.get(startSequence)
        if (!startPacket || !payloadStartsH264AccessUnit(startPacket.payload)) {
            return { ready: false, rejectReason: 'invalid-keyframe-start', startSequence }
        }

        const missingSequenceRanges = this.findMissingSequenceRanges(frame, startSequence, frame.markerSequence)
        if (missingSequenceRanges.length) return { ready: false, startSequence, missingSequenceRanges }

        const ordered = this.collect(frame, startSequence, frame.markerSequence)
        if (!ordered) return { ready: false, startSequence, missingSequenceRanges }
        return { ready: true, startSequence, ordered, missingSequenceRanges: [] }
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

    findMissingSequenceRanges(frame, startSequence, markerSequence) {
        if (startSequence === null || startSequence === undefined || markerSequence === null || markerSequence === undefined) return []
        const distance = sequenceDistance(startSequence, markerSequence)
        if (distance >= this.maxAccessUnitPackets) return [{ start: startSequence, end: markerSequence, invalidRange: true }]

        const ranges = []
        let rangeStart = null
        let previousMissing = null
        for (let offset = 0; offset <= distance; offset++) {
            const sequenceNumber = (startSequence + offset) & 0xffff
            if (frame.packets.has(sequenceNumber)) {
                if (rangeStart !== null) {
                    ranges.push({ start: rangeStart, end: previousMissing })
                    rangeStart = null
                    previousMissing = null
                }
                continue
            }
            if (rangeStart === null) rangeStart = sequenceNumber
            previousMissing = sequenceNumber
        }
        if (rangeStart !== null) ranges.push({ start: rangeStart, end: previousMissing })
        return ranges
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

    acceptFrame(frame, result) {
        this.clearFrameTimer(frame)
        this.frames.delete(frame.key)

        const keyframe = result.ordered.some(packet => payloadStartsH264Idr(packet.payload))
        const finalizeReason = frame.reorderedPacketCount > 0 ? 'complete-after-reorder' : 'complete-in-order'
        this.stats.acceptedAccessUnits++
        if (this.stats.firstForwardedRtpTimestamp === null) {
            this.stats.firstForwardedRtpTimestamp = frame.timestamp
        }
        this.mediaSsrc = frame.ssrc
        this.synced = true
        this.expectedSequence = nextSequence(frame.markerSequence)

        appendBounded(this.auDiagnostics, {
            timestamp: frame.timestamp,
            startSequence: result.startSequence,
            markerSequence: frame.markerSequence,
            markerSeen: true,
            reorderedPacketCount: frame.reorderedPacketCount,
            missingSequenceRanges: [],
            finalizeReason,
            rejectReason: null
        }, MAX_AU_DIAGNOSTICS)

        return {
            accepted: true,
            timestamp: frame.timestamp,
            keyframe,
            finalizeReason,
            packets: this.renumber(result.ordered)
        }
    }

    rejectFrame(frame, reason, { fromTimeout = false } = {}) {
        if (!frame || !this.frames.has(frame.key)) return
        const wasCurrentSyncedFrame = this.synced && this.currentSyncedFrame() === frame
        const startSequence = this.synced && this.expectedSequence !== null
            ? this.expectedSequence
            : this.findKeyframeStart(frame)
        const missingSequenceRanges = frame.markerSeen && startSequence !== null
            ? this.findMissingSequenceRanges(frame, startSequence, frame.markerSequence)
            : []

        this.clearFrameTimer(frame)
        this.frames.delete(frame.key)
        this.stats.droppedAccessUnits++

        if (!this.synced && startSequence === null) this.stats.waitingForKeyframe++
        if (wasCurrentSyncedFrame) {
            this.synced = false
            this.expectedSequence = null
            this.stats.resyncs++
            try { this.requestKeyFrame() } catch {}
        }

        appendBounded(this.auDiagnostics, {
            timestamp: frame.timestamp,
            startSequence,
            markerSequence: frame.markerSequence,
            markerSeen: frame.markerSeen,
            reorderedPacketCount: frame.reorderedPacketCount,
            missingSequenceRanges,
            finalizeReason: null,
            rejectReason: reason,
            boundedReorderExpiry: fromTimeout
        }, MAX_AU_DIAGNOSTICS)
    }

    getTimeoutRejectReason(frame) {
        const startSequence = this.synced && this.expectedSequence !== null
            ? this.expectedSequence
            : this.findKeyframeStart(frame)
        if (startSequence === null) return 'reorder-timeout-no-keyframe-start'
        const missing = this.findMissingSequenceRanges(frame, startSequence, frame.markerSequence)
        if (missing.length) return 'reorder-timeout-missing-packets'
        return 'reorder-timeout-incomplete-access-unit'
    }

    discardSupersededFrames(acceptedKey) {
        for (const frame of [...this.frames.values()]) {
            if (frame.key === acceptedKey) continue
            this.clearFrameTimer(frame)
            this.frames.delete(frame.key)
            appendBounded(this.auDiagnostics, {
                timestamp: frame.timestamp,
                startSequence: this.findKeyframeStart(frame),
                markerSequence: frame.markerSequence,
                markerSeen: frame.markerSeen,
                reorderedPacketCount: frame.reorderedPacketCount,
                missingSequenceRanges: [],
                finalizeReason: null,
                rejectReason: 'superseded-by-keyframe'
            }, MAX_AU_DIAGNOSTICS)
        }
    }

    clearFrameTimer(frame) {
        if (!frame?.timer) return
        this.clearTimer(frame.timer)
        frame.timer = null
    }

    renumber(orderedPackets) {
        return orderedPackets.map(packet => {
            const output = Buffer.from(packet.buffer)
            output.writeUInt16BE(this.outputSequence, 2)
            this.outputSequence = nextSequence(this.outputSequence)
            return output
        })
    }

    combineAccepted(accessUnits) {
        if (accessUnits.length === 1) return accessUnits[0]
        return {
            accepted: true,
            timestamp: accessUnits[0].timestamp,
            keyframe: accessUnits.some(unit => unit.keyframe),
            finalizeReason: 'multiple-complete-access-units',
            packets: accessUnits.flatMap(unit => unit.packets),
            accessUnits
        }
    }

    snapshotStats() {
        const pendingAccessUnits = [...this.frames.values()].map(frame => {
            const startSequence = this.synced && this.expectedSequence !== null
                ? this.expectedSequence
                : this.findKeyframeStart(frame)
            return {
                timestamp: frame.timestamp,
                startSequence,
                markerSequence: frame.markerSequence,
                markerSeen: frame.markerSeen,
                reorderedPacketCount: frame.reorderedPacketCount,
                missingSequenceRanges: frame.markerSeen && startSequence !== null
                    ? this.findMissingSequenceRanges(frame, startSequence, frame.markerSequence)
                    : []
            }
        })
        return {
            ...this.stats,
            reorderWaitMs: this.reorderWaitMs,
            maxReorderPackets: this.maxReorderPackets,
            packetDiagnostics: this.packetDiagnostics.map(entry => ({ ...entry })),
            auDiagnostics: this.auDiagnostics.map(entry => ({
                ...entry,
                missingSequenceRanges: entry.missingSequenceRanges.map(range => ({ ...range }))
            })),
            pendingAccessUnits
        }
    }

    stop() {
        for (const frame of this.frames.values()) this.clearFrameTimer(frame)
        this.frames.clear()
        this.seenPackets.clear()
        this.lastArrivalSequenceBySsrc.clear()
    }
}
