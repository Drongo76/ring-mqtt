import test from 'node:test'
import assert from 'node:assert/strict'
import { AccessUnitBuffer, RTP_VIDEO_CLOCK_RATE } from '../lib/streaming/access-unit-buffer.js'
import { WarmSessionManager, WARM_STATES } from '../lib/streaming/warm-session-manager.js'

const TICK_MS = 100
const GOP_TICKS = 10 // one keyframe per second at 10 fps
const FRAME_RTP_TICKS = (RTP_VIDEO_CLOCK_RATE * TICK_MS) / 1000
const WINDOW_MS = 4000

const CONFIG = Object.freeze({
    sessionMaxAgeMs: 60_000,
    rotationLeadMs: 20_000,
    readyTimeoutMs: 5_000,
    stallTimeoutMs: 3_000,
    backoff: { initialMs: 1000, maxMs: 8000, factor: 2 },
    degradedAfterFailures: 3
})

const flush = () => new Promise(resolve => setImmediate(resolve))

class FakeClock {
    constructor(start = 0) {
        this.current = start
        this.sequence = 0
        this.pending = new Map()
        this.now = () => this.current
        this.setTimer = (callback, delayMs) => {
            const id = ++this.sequence
            this.pending.set(id, { at: this.current + Math.max(0, delayMs), callback, id })
            return id
        }
        this.clearTimer = id => { this.pending.delete(id) }
    }

    get pendingCount() {
        return this.pending.size
    }

    // Runs every timer due up to `target` in order, then settles the clock at `target`.
    async advanceTo(target) {
        while (true) {
            const due = [...this.pending.values()]
                .filter(timer => timer.at <= target)
                .sort((a, b) => a.at - b.at || a.id - b.id)[0]
            if (!due) break
            this.pending.delete(due.id)
            this.current = Math.max(this.current, due.at)
            due.callback()
            await flush()
        }
        this.current = target
    }
}

class FakeSession {
    constructor(id, clock) {
        this.id = id
        this.clock = clock
        this.unitListeners = new Set()
        this.endListeners = new Set()
        this.stopped = false
        this.ended = false
        this.keyFrameRequests = 0
        this.frameIndex = 0
        this.producing = true
    }

    onAccessUnit(listener) {
        this.unitListeners.add(listener)
        return () => this.unitListeners.delete(listener)
    }

    onEnded(listener) {
        this.endListeners.add(listener)
        return () => this.endListeners.delete(listener)
    }

    requestKeyFrame() { this.keyFrameRequests++ }

    stop() {
        this.stopped = true
        this.producing = false
    }

    get alive() {
        return !this.stopped && !this.ended
    }

    emitUnit({ keyframe }) {
        const index = this.frameIndex++
        const unit = {
            timestamp: (index * FRAME_RTP_TICKS) >>> 0,
            keyframe,
            packets: [Buffer.alloc(100, index & 0xff)]
        }
        for (const listener of [...this.unitListeners]) listener(unit)
    }

    // Emits the next frame of a 10 fps stream with a keyframe every second.
    produceTick() {
        if (!this.alive || !this.producing) return
        this.emitUnit({ keyframe: this.frameIndex % GOP_TICKS === 0 })
    }

    end() {
        this.ended = true
        for (const listener of [...this.endListeners]) listener()
    }
}

class Harness {
    constructor(overrides = {}) {
        this.clock = new FakeClock()
        this.sessions = []
        this.createCalls = 0
        this.failCreate = 0
        this.holdNewSessions = false
        this.events = []
        this.manager = new WarmSessionManager({
            ...CONFIG,
            ...overrides,
            now: this.clock.now,
            setTimer: this.clock.setTimer,
            clearTimer: this.clock.clearTimer,
            createBuffer: () => new AccessUnitBuffer({ maxDurationMs: WINDOW_MS, now: this.clock.now }),
            createSession: async ({ id }) => {
                this.createCalls++
                if (this.failCreate > 0) {
                    this.failCreate--
                    throw new Error('ring refused')
                }
                const session = new FakeSession(id, this.clock)
                session.producing = !this.holdNewSessions
                this.sessions.push(session)
                return session
            }
        })
        this.manager.on('state', status => this.events.push(status.state))
    }

    get live() {
        return this.sessions.filter(session => session.alive)
    }

    // Advances time in 100 ms steps; every live producing session emits one frame per step.
    async run(ms, { onTick } = {}) {
        const end = this.clock.current + ms
        while (this.clock.current < end) {
            await this.clock.advanceTo(Math.min(end, this.clock.current + TICK_MS))
            for (const session of [...this.sessions]) session.produceTick()
            await flush()
            if (onTick) onTick(this.clock.current)
        }
    }
}

async function started(overrides) {
    const harness = new Harness(overrides)
    harness.manager.start()
    await flush()
    return harness
}

test('constructor validates its arguments', () => {
    assert.throws(() => new WarmSessionManager({}), TypeError)
    assert.throws(() => new WarmSessionManager({ createSession: async () => ({}), sessionMaxAgeMs: 1000, rotationLeadMs: 2000 }), RangeError)
    assert.throws(() => new WarmSessionManager({ createSession: async () => ({}), rotationLeadMs: 0 }), RangeError)
})

test('start creates one session, asks for a keyframe and becomes warm only once a keyframe arrives', async () => {
    const harness = await started()
    const { manager } = harness

    assert.equal(manager.state, WARM_STATES.STARTING)
    assert.equal(harness.createCalls, 1)
    assert.equal(harness.sessions[0].keyFrameRequests, 1)
    assert.equal(manager.activeBuffer, null)

    harness.sessions[0].emitUnit({ keyframe: false })
    await flush()
    assert.equal(manager.state, WARM_STATES.STARTING, 'a delta frame alone does not make the source usable')

    harness.sessions[0].emitUnit({ keyframe: true })
    await flush()
    assert.equal(manager.state, WARM_STATES.WARM)
    assert.ok(manager.activeBuffer)
    assert.equal(manager.status().activeSessionId, 1)
})

test('start and stop are idempotent', async () => {
    const harness = await started()
    harness.manager.start()
    harness.manager.start()
    await flush()
    assert.equal(harness.createCalls, 1)

    harness.manager.stop()
    harness.manager.stop()
    assert.equal(harness.manager.state, WARM_STATES.STOPPED)
})

test('video keeps flowing into the active buffer and can be extracted from a keyframe', async () => {
    const harness = await started()
    await harness.run(6000)

    const extracted = harness.manager.activeBuffer.extractAll()
    assert.equal(extracted.units[0].keyframe, true)
    assert.ok(extracted.rtpSpanMs >= WINDOW_MS - 100)
    assert.ok(harness.manager.activeBuffer.newestAgeMs() <= TICK_MS)
})

test('a session that never delivers a keyframe is dropped after the ready timeout and retried after a backoff', async () => {
    const harness = await started()
    harness.sessions[0].producing = false

    await harness.run(CONFIG.readyTimeoutMs + 100)
    assert.equal(harness.sessions[0].stopped, true)
    assert.equal(harness.manager.state, WARM_STATES.BACKOFF)
    assert.equal(harness.manager.status().readyTimeouts, 1)
    assert.equal(harness.manager.status().consecutiveFailures, 1)

    await harness.run(CONFIG.backoff.initialMs + 100)
    assert.equal(harness.createCalls, 2)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.manager.status().consecutiveFailures, 0)
})

test('createSession failures back off exponentially up to the cap', async () => {
    const harness = new Harness()
    harness.failCreate = 6
    const startedAt = []
    const original = harness.manager.createSession
    harness.manager.createSession = async args => {
        startedAt.push(harness.clock.current)
        return original(args)
    }

    harness.manager.start()
    await harness.run(40_000)

    const gaps = startedAt.slice(1).map((at, i) => at - startedAt[i])
    assert.deepEqual(gaps.slice(0, 5), [1000, 2000, 4000, 8000, 8000])
    assert.equal(harness.manager.state, WARM_STATES.WARM)
})

test('repeated failures flag the manager as degraded and a success recovers it', async () => {
    const harness = new Harness()
    harness.failCreate = CONFIG.degradedAfterFailures
    const degraded = []
    const recovered = []
    harness.manager.on('degraded', status => degraded.push(status.consecutiveFailures))
    harness.manager.on('recovered', () => recovered.push(true))

    harness.manager.start()
    await harness.run(20_000)

    assert.deepEqual(degraded, [CONFIG.degradedAfterFailures])
    assert.equal(recovered.length, 1)
    assert.equal(harness.manager.status().degraded, false)
    assert.equal(harness.manager.status().consecutiveFailures, 0)
})

test('an unexpected end of the active session leads to a backoff and a fresh session', async () => {
    const harness = await started()
    await harness.run(3000)
    assert.equal(harness.manager.state, WARM_STATES.WARM)

    harness.sessions[0].end()
    await flush()
    assert.equal(harness.manager.state, WARM_STATES.BACKOFF)
    assert.equal(harness.manager.activeBuffer, null)
    assert.equal(harness.sessions[0].stopped, true)

    await harness.run(CONFIG.backoff.initialMs + 200)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.manager.status().activeSessionId, 2)
    assert.equal(harness.manager.status().unexpectedEnds, 1)
})

test('a stalled session that never reports its end is detected from the missing video', async () => {
    const harness = await started()
    await harness.run(3000)
    harness.sessions[0].producing = false // silent, but no end event

    await harness.run(CONFIG.stallTimeoutMs + 200)
    assert.equal(harness.manager.status().stalls, 1)
    assert.equal(harness.sessions[0].stopped, true)
    assert.notEqual(harness.manager.state, WARM_STATES.WARM)

    await harness.run(CONFIG.backoff.initialMs + 300)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.manager.status().activeSessionId, 2)
})

test('a healthy stream is never mistaken for a stall', async () => {
    const harness = await started()
    await harness.run(30_000)
    assert.equal(harness.manager.status().stalls, 0)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.createCalls, 1)
})

test('rotation: a replacement starts before the age limit and the switch waits for a full window', async () => {
    const harness = await started()
    const rotateAt = CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs

    await harness.run(rotateAt - 200)
    assert.equal(harness.createCalls, 1)
    assert.equal(harness.manager.status().rotationPending, false)

    await harness.run(400)
    assert.equal(harness.createCalls, 2, 'replacement launched at the rotation point')
    assert.equal(harness.manager.status().rotationPending, true)
    assert.equal(harness.manager.status().activeSessionId, 1, 'the old session keeps serving meanwhile')

    // New session has a keyframe within a second, but the window is only full after WINDOW_MS.
    await harness.run(WINDOW_MS - 1500)
    assert.equal(harness.manager.status().activeSessionId, 1)

    await harness.run(2500)
    assert.equal(harness.manager.status().activeSessionId, 2)
    assert.equal(harness.manager.status().rotations, 1)
    assert.equal(harness.sessions[0].stopped, true, 'old session is released after the switch')
    assert.equal(harness.sessions[1].stopped, false)

    const window = harness.manager.activeBuffer.extractAll()
    assert.ok(window.rtpSpanMs >= WINDOW_MS - 1100, 'the new source already holds (nearly) a full window at switch time')
    assert.equal(window.units[0].keyframe, true)
})

test('rotation never leaves a moment without a usable buffer', async () => {
    const harness = await started()
    let samples = 0
    let withoutBuffer = 0
    let nonKeyframeStart = 0

    await harness.run(0)
    await harness.run(3 * CONFIG.sessionMaxAgeMs, {
        onTick: at => {
            if (at < 2000) return
            samples++
            const buffer = harness.manager.activeBuffer
            if (!buffer) {
                withoutBuffer++
                return
            }
            const extracted = buffer.extractAll()
            if (!extracted || !extracted.units[0].keyframe) nonKeyframeStart++
        }
    })

    assert.ok(harness.manager.status().rotations >= 3)
    assert.equal(withoutBuffer, 0)
    assert.equal(nonKeyframeStart, 0)
    assert.ok(samples > 1000)
    assert.equal(harness.live.length, 1, 'exactly one live session remains')
})

test('rotation: when the old session reaches its limit first, a ready replacement is promoted anyway', async () => {
    // Lead shorter than the window: the deadline arrives before the replacement window is full.
    const harness = await started({ rotationLeadMs: 2000 })
    await harness.run(CONFIG.sessionMaxAgeMs - 2000 + 100)
    assert.equal(harness.manager.status().rotationPending, true)

    await harness.run(2000)
    assert.equal(harness.manager.status().activeSessionId, 2)
    assert.equal(harness.manager.status().rotations, 1)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
})

test('rotation: a failing replacement does not disturb the active session and is retried', async () => {
    const harness = await started()
    await harness.run(CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs - 200)

    harness.failCreate = 2
    await harness.run(300)
    assert.equal(harness.manager.status().activeSessionId, 1)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.ok(harness.manager.status().failures >= 1)

    await harness.run(CONFIG.rotationLeadMs - 500)
    // Eventually a later attempt succeeds and takes over (failed attempts consume session ids).
    assert.ok(harness.manager.status().activeSessionId > 1)
    assert.equal(harness.manager.status().rotations, 1)
    assert.equal(harness.sessions.length, 2, 'only the successful attempt produced a session')
    assert.equal(harness.manager.state, WARM_STATES.WARM)
})

test('rotation: if no replacement ever becomes ready the old session is retired at its limit and a new one starts', async () => {
    const harness = await started()
    await harness.run(CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs - 200)
    harness.failCreate = 1000

    await harness.run(CONFIG.rotationLeadMs + 500)
    assert.equal(harness.sessions[0].stopped, true, 'the old session does not outlive its limit')
    assert.equal(harness.manager.activeBuffer, null)
    assert.notEqual(harness.manager.state, WARM_STATES.WARM)

    harness.failCreate = 0
    await harness.run(CONFIG.backoff.maxMs + 500)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
})

test('the active session ending while a replacement is ready promotes it immediately, without a backoff', async () => {
    const harness = await started()
    await harness.run(CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs + 1500) // replacement has a keyframe, window not yet full
    assert.equal(harness.manager.status().rotationPending, true)

    harness.events.length = 0
    harness.sessions[0].end()
    await flush()

    assert.equal(harness.manager.status().activeSessionId, 2)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.ok(!harness.events.includes(WARM_STATES.BACKOFF))
    assert.equal(harness.manager.status().consecutiveFailures, 0)
})

test('the active session ending while the replacement is still connecting waits for the replacement', async () => {
    const harness = await started()
    await harness.run(CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs - 300)
    harness.holdNewSessions = true // the replacement will connect but deliver no video yet
    await harness.run(500)
    assert.equal(harness.manager.status().rotationPending, true)

    harness.sessions[0].end()
    await flush()
    assert.equal(harness.manager.state, WARM_STATES.STARTING)
    assert.equal(harness.createCalls, 2, 'no extra session is started')

    harness.sessions[1].producing = true
    await harness.run(1500)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.manager.status().activeSessionId, 2)
    assert.equal(harness.manager.status().rotations, 0, 'the old session ended on its own, this is a recovery and not a rotation')
})

test('stop releases every session, buffer and timer', async () => {
    const harness = await started()
    await harness.run(CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs + 500) // active + pending
    assert.equal(harness.live.length, 2)

    harness.manager.stop()
    assert.equal(harness.manager.state, WARM_STATES.STOPPED)
    assert.equal(harness.live.length, 0)
    assert.equal(harness.manager.activeBuffer, null)
    assert.equal(harness.clock.pendingCount, 0, 'no timer survives stop')
})

test('a session created after stop is released immediately', async () => {
    const harness = new Harness()
    let release
    const original = harness.manager.createSession
    harness.manager.createSession = args => new Promise(resolve => { release = () => resolve(original(args)) })

    harness.manager.start()
    await flush()
    harness.manager.stop()
    release()
    await flush()
    await flush()

    assert.equal(harness.sessions.length, 1)
    assert.equal(harness.sessions[0].stopped, true)
    assert.equal(harness.manager.state, WARM_STATES.STOPPED)
})

test('events from a session that was already replaced are ignored', async () => {
    const harness = await started()
    await harness.run(CONFIG.sessionMaxAgeMs - CONFIG.rotationLeadMs + WINDOW_MS + 1500)
    assert.equal(harness.manager.status().activeSessionId, 2)

    const before = harness.manager.activeBuffer.stats().unitCount
    const old = harness.sessions[0]
    old.ended = false
    old.emitUnit({ keyframe: true })
    old.end()
    await flush()

    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.manager.status().activeSessionId, 2)
    assert.equal(harness.manager.status().unexpectedEnds, 0)
    assert.ok(harness.manager.activeBuffer.stats().unitCount >= before)
})

test('the manager can be started again after stop', async () => {
    const harness = await started()
    await harness.run(2000)
    harness.manager.stop()
    await flush()

    harness.manager.start()
    await flush()
    await harness.run(1500)
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.equal(harness.manager.status().activeSessionId, 2)
})

test('state events report each transition once', async () => {
    const harness = await started()
    await harness.run(2000)
    harness.sessions[0].end()
    await harness.run(CONFIG.backoff.initialMs + 500)

    assert.deepEqual(harness.events, [
        WARM_STATES.STARTING,
        WARM_STATES.WARM,
        WARM_STATES.BACKOFF,
        WARM_STATES.STARTING,
        WARM_STATES.WARM
    ])
})

test('soak: thirty minutes of simulated time with periodic failures stays healthy and leak-free', async () => {
    const harness = await started()
    let usable = 0
    let total = 0

    await harness.run(30 * 60 * 1000, {
        onTick: at => {
            // Inject faults: the active session dies at minute 12 and a rotation fails at minute 20.
            if (at === 12 * 60 * 1000) harness.live[0]?.end()
            if (at === 20 * 60 * 1000) harness.failCreate = 2
            if (at < 5000) return
            total++
            const extracted = harness.manager.activeBuffer?.extractAll()
            if (extracted && extracted.units[0].keyframe) usable++
        }
    })

    const status = harness.manager.status()
    assert.equal(harness.manager.state, WARM_STATES.WARM)
    assert.ok(status.rotations >= 3, `rotations: ${status.rotations}`)
    assert.ok(usable / total > 0.97, `availability ${(100 * usable / total).toFixed(2)}%`)
    assert.ok(harness.live.length <= 2, 'at most active plus one replacement are ever alive at the end')
    assert.ok(status.buffer.bytes < 1024 * 1024, 'buffer memory stays bounded')
    assert.ok(harness.clock.pendingCount <= 6, 'the timer count stays bounded')
})
