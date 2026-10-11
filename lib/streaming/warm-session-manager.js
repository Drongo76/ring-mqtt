// Keeps one live Ring WebRTC session "warm" and continuously buffers its video, so a consumer can
// start from video that is already flowing instead of paying the connection setup time.
//
// Ring terminates live sessions after roughly ten minutes, so the manager rotates: a replacement
// session is started while the current one is still healthy, and the active source is switched only
// once the replacement has a full buffer window of its own. Each session has a private
// AccessUnitBuffer, so a consumer never sees video stitched across two sources.
//
// Everything with side effects is injected (session factory, clock, timers), which keeps the state
// machine deterministic and testable.

import { EventEmitter } from 'node:events'
import { AccessUnitBuffer } from './access-unit-buffer.js'

export const WARM_STATES = Object.freeze({
    STOPPED: 'stopped',
    STARTING: 'starting',
    WARM: 'warm',
    BACKOFF: 'backoff'
})

export const DEFAULT_SESSION_MAX_AGE_MS = 8 * 60 * 1000
export const DEFAULT_ROTATION_LEAD_MS = 60 * 1000
export const DEFAULT_READY_TIMEOUT_MS = 20 * 1000
export const DEFAULT_STALL_TIMEOUT_MS = 10 * 1000
export const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 30000, factor: 2 })
export const DEFAULT_DEGRADED_AFTER_FAILURES = 5

export class WarmSessionManager extends EventEmitter {
    // createSession({ id }) -> Promise<{
    //   onAccessUnit(listener): unsubscribe,   listener({ timestamp, keyframe, packets })
    //   onEnded(listener): unsubscribe,
    //   requestKeyFrame(): void,
    //   stop(): void
    // }>
    constructor({
        createSession,
        createBuffer = () => new AccessUnitBuffer(),
        now = Date.now,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        sessionMaxAgeMs = DEFAULT_SESSION_MAX_AGE_MS,
        rotationLeadMs = DEFAULT_ROTATION_LEAD_MS,
        readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
        stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
        backoff = DEFAULT_BACKOFF,
        degradedAfterFailures = DEFAULT_DEGRADED_AFTER_FAILURES
    } = {}) {
        super()
        if (typeof createSession !== 'function') throw new TypeError('createSession must be a function')
        if (!(sessionMaxAgeMs > rotationLeadMs && rotationLeadMs > 0)) {
            throw new RangeError('sessionMaxAgeMs must be greater than rotationLeadMs, and both positive')
        }
        this.createSession = createSession
        this.createBuffer = createBuffer
        this.now = now
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.sessionMaxAgeMs = sessionMaxAgeMs
        this.rotationLeadMs = rotationLeadMs
        this.readyTimeoutMs = readyTimeoutMs
        this.stallTimeoutMs = stallTimeoutMs
        this.backoff = { ...DEFAULT_BACKOFF, ...backoff }
        this.degradedAfterFailures = degradedAfterFailures

        this.state = WARM_STATES.STOPPED
        this.active = null
        this.pending = null
        this.sequence = 0
        this.generation = 0
        this.timers = { rotate: null, deadline: null, promote: null, backoff: null, stall: null }
        this.consecutiveFailures = 0
        this.totals = { started: 0, rotations: 0, failures: 0, unexpectedEnds: 0, readyTimeouts: 0, stalls: 0 }
        this.degraded = false
    }

    start() {
        if (this.state !== WARM_STATES.STOPPED) return
        this.generation++
        this.setState(WARM_STATES.STARTING)
        this.launch()
    }

    stop() {
        if (this.state === WARM_STATES.STOPPED) return
        this.generation++
        this.clearAllTimers()
        this.teardown(this.pending)
        this.teardown(this.active)
        this.pending = null
        this.active = null
        this.setState(WARM_STATES.STOPPED)
    }

    // Buffer of the active source, or null when nothing is warm.
    get activeBuffer() {
        return this.active ? this.active.buffer : null
    }

    status() {
        return {
            state: this.state,
            degraded: this.degraded,
            consecutiveFailures: this.consecutiveFailures,
            activeSessionId: this.active ? this.active.id : null,
            activeSessionAgeMs: this.active ? this.now() - this.active.startedAtMs : null,
            rotationPending: Boolean(this.pending && this.active),
            ...this.totals,
            buffer: this.active ? this.active.buffer.stats() : null
        }
    }

    // ---- session lifecycle -------------------------------------------------------------------

    launch() {
        if (this.pending) return
        const generation = this.generation
        const id = ++this.sequence
        const slot = {
            id,
            session: null,
            buffer: this.createBuffer(),
            startedAtMs: this.now(),
            ready: false,
            readyAtMs: null,
            lastUnitAtMs: null,
            closed: false,
            unsubscribe: [],
            readyTimer: null
        }
        this.pending = slot
        this.totals.started++

        slot.readyTimer = this.setTimer(() => {
            slot.readyTimer = null
            if (slot.closed || this.pending !== slot) return
            this.totals.readyTimeouts++
            this.failPending(slot, 'ready-timeout')
        }, this.readyTimeoutMs)

        Promise.resolve()
            .then(() => this.createSession({ id }))
            .then(session => {
                if (generation !== this.generation || slot.closed) {
                    session?.stop?.()
                    return
                }
                slot.session = session
                slot.unsubscribe.push(
                    session.onAccessUnit(unit => this.handleAccessUnit(slot, unit)),
                    session.onEnded(() => this.handleEnded(slot))
                )
                session.requestKeyFrame?.()
            })
            .catch(() => {
                if (generation !== this.generation || slot.closed) return
                this.failPending(slot, 'create-failed')
            })
    }

    handleAccessUnit(slot, unit) {
        if (slot.closed) return
        slot.lastUnitAtMs = this.now()
        const stored = slot.buffer.push(unit)
        if (!stored || slot.ready || !unit.keyframe) return
        slot.ready = true
        slot.readyAtMs = this.now()
        if (slot.readyTimer) {
            this.clearTimer(slot.readyTimer)
            slot.readyTimer = null
        }
        if (this.pending === slot) this.onPendingReady(slot)
    }

    onPendingReady(slot) {
        if (!this.active) {
            this.promote(slot)
            return
        }
        // Rotation: switch only once the replacement holds a full window of its own, or when the
        // current session is about to hit its age limit, whichever comes first.
        const windowMs = slot.buffer.maxDurationMs
        const byWindow = slot.readyAtMs + windowMs
        const byDeadline = this.active.startedAtMs + this.sessionMaxAgeMs
        const at = Math.min(byWindow, byDeadline)
        this.timers.promote = this.setTimer(() => {
            this.timers.promote = null
            if (this.pending === slot && !slot.closed) this.promote(slot)
        }, Math.max(0, at - this.now()))
    }

    promote(slot) {
        const previous = this.active
        this.pending = null
        this.active = slot
        this.clearTimer(this.timers.promote)
        this.timers.promote = null
        if (previous) {
            this.totals.rotations++
            this.teardown(previous)
        }
        this.consecutiveFailures = 0
        if (this.degraded) {
            this.degraded = false
            this.emit('recovered', this.status())
        }
        this.scheduleRotation()
        this.armStallWatch()
        this.setState(WARM_STATES.WARM)
    }

    // A session can stall without ever reporting that it ended. Detect it from the missing video.
    armStallWatch() {
        this.clearTimer(this.timers.stall)
        const slot = this.active
        if (!slot) {
            this.timers.stall = null
            return
        }
        const sinceLast = this.now() - (slot.lastUnitAtMs ?? slot.readyAtMs ?? slot.startedAtMs)
        this.timers.stall = this.setTimer(() => {
            this.timers.stall = null
            if (this.active !== slot || slot.closed) return
            const silentMs = this.now() - (slot.lastUnitAtMs ?? slot.startedAtMs)
            if (silentMs >= this.stallTimeoutMs) {
                this.totals.stalls++
                this.handleEnded(slot)
                return
            }
            this.armStallWatch()
        }, Math.max(1, this.stallTimeoutMs - sinceLast))
    }

    scheduleRotation() {
        this.clearTimer(this.timers.rotate)
        this.clearTimer(this.timers.deadline)
        const age = this.now() - this.active.startedAtMs
        const rotateIn = Math.max(0, this.sessionMaxAgeMs - this.rotationLeadMs - age)
        const deadlineIn = Math.max(0, this.sessionMaxAgeMs - age)
        this.timers.rotate = this.setTimer(() => {
            this.timers.rotate = null
            if (this.active && !this.pending) this.launch()
        }, rotateIn)
        this.timers.deadline = this.setTimer(() => {
            this.timers.deadline = null
            this.onActiveDeadline()
        }, deadlineIn)
    }

    // The active session reached its age limit without a ready replacement.
    onActiveDeadline() {
        if (!this.active) return
        if (this.pending && this.pending.ready) {
            this.promote(this.pending)
            return
        }
        this.teardown(this.active)
        this.active = null
        this.clearTimer(this.timers.rotate)
        this.clearTimer(this.timers.stall)
        this.timers.rotate = null
        this.timers.stall = null
        this.setState(WARM_STATES.STARTING)
        this.launch()
    }

    handleEnded(slot) {
        if (slot.closed) return
        this.totals.unexpectedEnds++
        if (this.pending === slot) {
            this.failPending(slot, 'ended-while-pending')
            return
        }
        if (this.active !== slot) return

        this.teardown(slot)
        this.active = null
        this.clearTimer(this.timers.rotate)
        this.clearTimer(this.timers.deadline)
        this.clearTimer(this.timers.stall)
        this.timers.rotate = null
        this.timers.deadline = null
        this.timers.stall = null

        if (this.pending && this.pending.ready) {
            this.promote(this.pending)
            return
        }
        this.recordFailure()
        if (this.pending) {
            // A replacement is already connecting; wait for it instead of starting another one.
            this.setState(WARM_STATES.STARTING)
            return
        }
        this.scheduleBackoff()
    }

    failPending(slot, reason) {
        this.teardown(slot)
        this.pending = null
        this.clearTimer(this.timers.promote)
        this.timers.promote = null
        this.recordFailure()
        this.emit('session-failed', { id: slot.id, reason })
        if (this.active) {
            // Rotation attempt failed; the current session keeps serving. Retry after a backoff,
            // as long as it still has time left.
            this.retryRotationAfterBackoff()
            return
        }
        this.scheduleBackoff()
    }

    retryRotationAfterBackoff() {
        this.clearTimer(this.timers.backoff)
        this.timers.backoff = this.setTimer(() => {
            this.timers.backoff = null
            if (this.active && !this.pending) this.launch()
        }, this.backoffDelayMs())
    }

    recordFailure() {
        this.consecutiveFailures++
        this.totals.failures++
        if (!this.degraded && this.consecutiveFailures >= this.degradedAfterFailures) {
            this.degraded = true
            this.emit('degraded', this.status())
        }
    }

    backoffDelayMs() {
        const { initialMs, maxMs, factor } = this.backoff
        const attempt = Math.max(0, this.consecutiveFailures - 1)
        return Math.min(maxMs, initialMs * factor ** attempt)
    }

    scheduleBackoff() {
        this.clearTimer(this.timers.backoff)
        this.setState(WARM_STATES.BACKOFF)
        const generation = this.generation
        this.timers.backoff = this.setTimer(() => {
            this.timers.backoff = null
            if (generation !== this.generation) return
            this.setState(WARM_STATES.STARTING)
            this.launch()
        }, this.backoffDelayMs())
    }

    // ---- helpers -----------------------------------------------------------------------------

    teardown(slot) {
        if (!slot || slot.closed) return
        slot.closed = true
        if (slot.readyTimer) {
            this.clearTimer(slot.readyTimer)
            slot.readyTimer = null
        }
        for (const unsubscribe of slot.unsubscribe) {
            try { unsubscribe?.() } catch { /* a failing unsubscribe must not block cleanup */ }
        }
        slot.unsubscribe = []
        try { slot.session?.stop?.() } catch { /* the session is being discarded anyway */ }
        slot.buffer.clear()
    }

    clearAllTimers() {
        for (const key of Object.keys(this.timers)) {
            if (this.timers[key]) this.clearTimer(this.timers[key])
            this.timers[key] = null
        }
    }

    setState(state) {
        if (this.state === state) return
        this.state = state
        this.emit('state', this.status())
    }
}
