// Compact, bounded timeline of what the camera stream delivers at the start of a
// KI Burst (packets, access units, keyframe requests). Purely diagnostic: it records
// and formats events and never influences stream handling.

export const DEFAULT_MAX_TIMELINE_EVENTS = 120
export const DEFAULT_MAX_TIMELINE_PACKETS = 12
export const DUPLICATE_BUCKET_MS = 500
export const LARGE_ACCESS_UNIT_PACKETS = 20

export class KeyframeTimeline {
    constructor({ now = Date.now, startedAtMs = now(), maxEvents = DEFAULT_MAX_TIMELINE_EVENTS, maxPackets = DEFAULT_MAX_TIMELINE_PACKETS } = {}) {
        this.now = now
        this.startedAtMs = startedAtMs
        this.maxEvents = maxEvents
        this.maxPackets = maxPackets
        this.events = []
        this.packetsLogged = 0
        this.packetsSeen = 0
        this.duplicatesByBucket = {}
        this.truncated = false
    }

    // Consecutive identical events are folded into one entry ("... x5 until +t") so a long run
    // of dropped P-frames cannot push the interesting keyframe events out of the bounded log.
    add(text) {
        const at = this.now() - this.startedAtMs
        const last = this.events[this.events.length - 1]
        if (last && last.text === text) {
            last.count++
            last.lastAt = at
            return
        }
        if (this.events.length >= this.maxEvents) {
            this.truncated = true
            return
        }
        this.events.push({ text, at, count: 1, lastAt: at })
    }

    // Only the first few packets are listed individually; later ones are only counted.
    packet({ sequenceNumber, nalType, fuAStart, fuAEnd, marker, duplicate }) {
        this.packetsSeen++
        if (duplicate) {
            const bucket = Math.floor((this.now() - this.startedAtMs) / DUPLICATE_BUCKET_MS) * DUPLICATE_BUCKET_MS
            this.duplicatesByBucket[bucket] = (this.duplicatesByBucket[bucket] ?? 0) + 1
        }
        if (this.packetsLogged >= this.maxPackets) return
        this.packetsLogged++
        const flags = [fuAStart ? 'S' : '', fuAEnd ? 'E' : '', marker ? 'M' : '', duplicate ? 'dup' : ''].join('')
        this.add(`pkt seq=${sequenceNumber} nal=${nalType ?? '?'}${flags ? ` ${flags}` : ''}`)
    }

    accessUnit({ accepted, keyframe = false, packets = 0, reason = null, hasKeyframeStart = null, missing = null, markerSeen = null, nalTypes = null }) {
        if (accepted) {
            // Accepted P-frames are routine; only keyframes and the first accepted frame matter.
            this.add(keyframe ? `au ok IDR pkts=${packets}` : 'au ok P')
            return
        }
        let text = `au drop reason=${reason}${hasKeyframeStart === null ? '' : ` idrStart=${hasKeyframeStart ? 'yes' : 'no'}`}`
        // Details only for access units that could have been keyframes (keyframe start seen or large);
        // plain P-frame drops stay identical and therefore foldable.
        if (hasKeyframeStart || packets >= LARGE_ACCESS_UNIT_PACKETS) {
            text += ` pkts=${packets} missing=${missing ?? '?'} marker=${markerSeen ? 'yes' : 'no'}${Array.isArray(nalTypes) ? ` nals=${nalTypes.join(',')}` : ''}`
        }
        this.add(text)
    }

    mark(label) {
        this.add(label)
    }

    keyframeRequested(source) {
        this.add(`keyframe requested (${source})`)
    }

    pliSent({ ok = true, error = null } = {}) {
        this.add(ok ? 'PLI sent' : `PLI failed ${error ?? ''}`.trim())
    }

    snapshot() {
        const events = this.events.map(event => {
            const range = event.count > 1 ? ` x${event.count} until +${event.lastAt}` : ''
            return `+${event.at} ${event.text}${range}`
        })
        return { packetsSeen: this.packetsSeen, duplicatesPer500ms: { ...this.duplicatesByBucket }, truncated: this.truncated, events }
    }
}
