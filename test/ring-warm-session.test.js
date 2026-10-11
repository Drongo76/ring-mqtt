import test from 'node:test'
import assert from 'node:assert/strict'
import { createRingWarmSession } from '../lib/streaming/ring-warm-session.js'

// Minimal observable with the same subscribe/unsubscribe contract as an rxjs Subject.
class Stream {
    constructor({ replay = false } = {}) { this.listeners = new Set(); this.replay = replay; this.last = undefined; this.has = false }
    next(value) {
        this.last = value
        this.has = true
        for (const listener of [...this.listeners]) listener(value)
    }
    subscribe(listener) {
        if (this.replay && this.has) listener(this.last)
        this.listeners.add(listener)
        return { unsubscribe: () => this.listeners.delete(listener) }
    }
}

const rtp = bytes => ({ serialize: () => Buffer.from(bytes) })

function makeSession() {
    const session = {
        connection: { onCallAnswered: new Stream({ replay: true }) },
        onVideoRtp: new Stream(),
        onCallEnded: new Stream({ replay: true }),
        keyframeRequests: 0,
        stopped: 0,
        requestKeyFrame() { this.keyframeRequests++ },
        stop() { this.stopped++ }
    }
    return session
}

function makeGate(script = []) {
    const gate = {
        pushed: [],
        stopped: false,
        requestKeyFrame: null,
        push(packet) { gate.pushed.push(packet); return script.shift() ?? null },
        snapshotStats: () => ({ acceptedAccessUnits: gate.pushed.length }),
        stop() { gate.stopped = true }
    }
    return gate
}

test('a missing ticket is an error and no session is opened', async () => {
    let opened = false
    await assert.rejects(
        createRingWarmSession({ requestTicket: async () => null, openSession: () => { opened = true } }),
        /did not return a WebRTC signaling ticket/
    )
    assert.equal(opened, false)
})

test('the ticket is passed to the session and the gate requests keyframes through it', async () => {
    const session = makeSession()
    let usedTicket
    let gateOptions
    const warm = await createRingWarmSession({
        requestTicket: async () => 'T1',
        openSession: ticket => { usedTicket = ticket; return session },
        createGate: options => { gateOptions = options; return makeGate() }
    })
    assert.equal(usedTicket, 'T1')
    gateOptions.requestKeyFrame()
    warm.requestKeyFrame()
    assert.equal(session.keyframeRequests, 2)
})

test('complete access units from the gate reach listeners; incomplete ones do not', async () => {
    const session = makeSession()
    const unitA = { accepted: true, timestamp: 100, keyframe: true, packets: [Buffer.from('a')] }
    const gate = makeGate([null, unitA])
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => gate })
    const received = []
    warm.onAccessUnit(unit => received.push(unit))
    session.onVideoRtp.next(rtp([1]))
    session.onVideoRtp.next(rtp([2]))
    assert.equal(gate.pushed.length, 2)
    assert.deepEqual(received.map(unit => [unit.timestamp, unit.keyframe]), [[100, true]])
})

test('a combined result is split into its access units so GOP bookkeeping stays exact', async () => {
    const session = makeSession()
    const first = { timestamp: 1, keyframe: true, packets: [Buffer.from('k')] }
    const second = { timestamp: 2, keyframe: false, packets: [Buffer.from('p')] }
    const combined = { accepted: true, timestamp: 1, keyframe: true, packets: [...first.packets, ...second.packets], accessUnits: [first, second] }
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => makeGate([combined]) })
    const received = []
    warm.onAccessUnit(unit => received.push(unit))
    session.onVideoRtp.next(rtp([1]))
    assert.deepEqual(received.map(unit => [unit.timestamp, unit.keyframe]), [[1, true], [2, false]])
})

test('the SDP answer resolves once, including when the answer was already replayed', async () => {
    const session = makeSession()
    session.connection.onCallAnswered.next('v=0 sdp')
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => makeGate() })
    assert.equal(await warm.sdp, 'v=0 sdp')
})

test('a call that ends before the answer rejects the SDP promise without an unhandled rejection', async () => {
    const session = makeSession()
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => makeGate() })
    session.onCallEnded.next()
    await assert.rejects(warm.sdp, /ended before the warm session was answered/)
})

test('end listeners fire once, also for listeners added after the end', async () => {
    const session = makeSession()
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => makeGate() })
    let early = 0
    warm.onEnded(() => early++)
    session.onCallEnded.next()
    session.onCallEnded.next()
    let late = 0
    warm.onEnded(() => late++)
    assert.equal(early, 1)
    assert.equal(late, 1)
})

test('stop detaches everything, stops the gate and session once, and ignores later video', async () => {
    const session = makeSession()
    const gate = makeGate([{ accepted: true, timestamp: 1, keyframe: true, packets: [Buffer.from('x')] }])
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => gate })
    const received = []
    warm.onAccessUnit(unit => received.push(unit))
    warm.stop()
    warm.stop()
    session.onVideoRtp.next(rtp([1]))
    warm.requestKeyFrame()
    assert.equal(session.stopped, 1)
    assert.equal(gate.stopped, true)
    assert.equal(gate.pushed.length, 0)
    assert.equal(received.length, 0)
    assert.equal(session.keyframeRequests, 0)
    assert.equal(session.onVideoRtp.listeners.size, 0)
})

test('rtpIntegrity exposes the gate statistics of this source only', async () => {
    const session = makeSession()
    const gate = makeGate([null])
    const warm = await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => gate })
    session.onVideoRtp.next(rtp([1]))
    assert.deepEqual(warm.rtpIntegrity(), { acceptedAccessUnits: 1 })
})

test('a throwing gate is logged and does not break later packets', async () => {
    const session = makeSession()
    const logs = []
    let calls = 0
    const gate = { push: () => { if (calls++ === 0) throw new Error('bad packet'); return null }, snapshotStats: () => ({}), stop() {} }
    await createRingWarmSession({ requestTicket: async () => 'T', openSession: () => session, createGate: () => gate, onLog: m => logs.push(m) })
    session.onVideoRtp.next(rtp([1]))
    session.onVideoRtp.next(rtp([2]))
    assert.equal(calls, 2)
    assert.match(logs[0], /bad packet/)
})
