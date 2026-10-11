import { H264RtpFrameGate } from './h264-rtp-frame-gate.js'

// Adapts one Ring WebRTC session to the source contract of WarmSessionManager:
// complete, validated access units, an end notification, keyframe requests and a stop.
//
// `openSession(ticket)` must return an object shaped like StreamingSession
// (connection.onCallAnswered, onVideoRtp, onCallEnded, requestKeyFrame(), stop()),
// where the three streams are observables with subscribe(fn) -> { unsubscribe() }.
// Each source gets its own H264RtpFrameGate: a gate follows one RTP stream, so a new
// session can never be stitched onto the sequence numbers of an older one.

function subscribeOnce(observable, listener) {
    let done = false
    let subscription = null
    const handler = value => {
        if (done) return
        done = true
        subscription?.unsubscribe()
        listener(value)
    }
    subscription = observable.subscribe(handler)
    // A replaying observable may deliver synchronously, before `subscription` was assigned.
    if (done) subscription.unsubscribe()
    return () => {
        done = true
        subscription?.unsubscribe()
    }
}

export async function createRingWarmSession({
    requestTicket,
    openSession,
    createGate = options => new H264RtpFrameGate(options),
    onLog = () => {}
}) {
    const ticket = await requestTicket()
    if (!ticket) throw new Error('Ring did not return a WebRTC signaling ticket for the warm session')

    const session = openSession(ticket)
    const gate = createGate({ requestKeyFrame: () => session.requestKeyFrame() })
    const accessUnitListeners = new Set()
    const endListeners = new Set()
    let ended = false
    let stopped = false

    const sdp = new Promise((resolve, reject) => {
        const cancelAnswer = subscribeOnce(session.connection.onCallAnswered, resolve)
        subscribeOnce(session.onCallEnded, () => {
            cancelAnswer()
            reject(new Error('Ring call ended before the warm session was answered'))
        })
    })
    // Consumers await `sdp` when they need it; an unobserved rejection must not crash the worker.
    sdp.catch(() => {})

    const videoSubscription = session.onVideoRtp.subscribe(rtp => {
        if (stopped) return
        let result
        try {
            result = gate.push(rtp.serialize())
        } catch (error) {
            onLog(`Warm session RTP gate error: ${error?.message || error}`)
            return
        }
        if (!result?.accepted) return
        // The gate may hand out several complete access units at once; each is stored separately
        // so the buffer's keyframe/GOP bookkeeping stays exact.
        const units = result.accessUnits || [result]
        for (const unit of units) {
            const copy = { timestamp: unit.timestamp, keyframe: unit.keyframe, packets: unit.packets }
            for (const listener of [...accessUnitListeners]) listener(copy)
        }
    })

    const endSubscription = session.onCallEnded.subscribe(() => {
        if (ended) return
        ended = true
        for (const listener of [...endListeners]) listener()
    })

    return {
        sdp,
        onAccessUnit(listener) {
            accessUnitListeners.add(listener)
            return () => accessUnitListeners.delete(listener)
        },
        onEnded(listener) {
            endListeners.add(listener)
            if (ended) listener()
            return () => endListeners.delete(listener)
        },
        requestKeyFrame() {
            if (!stopped) session.requestKeyFrame()
        },
        rtpIntegrity() {
            return gate.snapshotStats()
        },
        stop() {
            if (stopped) return
            stopped = true
            videoSubscription.unsubscribe()
            endSubscription.unsubscribe()
            accessUnitListeners.clear()
            endListeners.clear()
            gate.stop()
            try { session.stop() } catch (error) { onLog(`Warm session stop failed: ${error?.message || error}`) }
        }
    }
}
