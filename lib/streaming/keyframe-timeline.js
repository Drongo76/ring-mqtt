// Compact, bounded timeline of what the camera stream delivers at the start of a
// KI Burst (packets, access units, keyframe requests). Purely diagnostic: it records
// and formats events and never influences stream handling.

export const DEFAULT_MAX_TIMELINE_EVENTS = 120
export const DEFAULT_MAX_TIMELINE_PACKETS = 12

export class KeyframeTimeline {
    constructor({ now = Date.now, startedAtMs = now(), maxEvents = DEFAULT_MAX_TIMELINE_EVENTS, maxPackets = DEFAULT_MAX_TIMELINE_PACKETS } = {}) {
        this.now = now
        this.startedAtMs = startedAtMs
        this.maxEvents = maxEvents
        this.maxPackets = maxPackets
        this.events = []
        this.packetsLogged = 0
        this.packetsSeen = 0
        this.truncated = false
    }

    add(text) {
        if (this.events.length >= this.maxEvents) {
            this.truncated = true
            return
        }
        this.events.push(`+${this.now() - this.startedAtMs} ${text}`)
    }

    // Only the first few packets are listed individually; later ones are only counted.
    packet({ sequenceNumber, nalType, fuAStart, fuAEnd, marker, duplicate }) {
        this.packetsSeen++
        if (this.packetsLogged >= this.maxPackets) return
        this.packetsLogged++
        const flags = [fuAStart ? 'S' : '', fuAEnd ? 'E' : '', marker ? 'M' : '', duplicate ? 'dup' : ''].join('')
        this.add(`pkt seq=${sequenceNumber} nal=${nalType ?? '?'}${flags ? ` ${flags}` : ''}`)
    }

    accessUnit({ accepted, keyframe = false, packets = 0, reason = null, hasKeyframeStart = null }) {
        if (accepted) {
            this.add(`au ok ${keyframe ? 'IDR' : 'P'} pkts=${packets}`)
        } else {
            this.add(`au drop reason=${reason}${hasKeyframeStart === null ? '' : ` idrStart=${hasKeyframeStart ? 'yes' : 'no'}`}`)
        }
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
        return { packetsSeen: this.packetsSeen, truncated: this.truncated, events: [...this.events] }
    }
}
