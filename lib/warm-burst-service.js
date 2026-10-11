import { WarmSessionManager } from './streaming/warm-session-manager.js'
import { createRingWarmSession } from './streaming/ring-warm-session.js'
import { WarmSourceUnavailableError } from './streaming/warm-burst-capture.js'

export const TICKET_REQUEST_TIMEOUT_MS = 15000

// Worker-side owner of the warm Ring session. It keeps the session warm while enabled, asks the
// main thread for signaling tickets (only the main thread has the Ring REST client), reports its
// state, and runs bursts from the warm buffer.
//
// All outside effects are injected, so it can be tested without Ring, rxjs or ffmpeg.
export class WarmBurstService {
    constructor({
        post,
        openSession,
        captureFromWarm,
        createManager = options => new WarmSessionManager(options),
        managerOptions = {},
        setTimer = setTimeout,
        clearTimer = clearTimeout
    }) {
        this.post = post
        this.openSession = openSession
        this.captureFromWarm = captureFromWarm
        this.createManager = createManager
        this.managerOptions = managerOptions
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.manager = null
        this.ticketRequests = new Map()
        this.ticketSequence = 0
    }

    get enabled() {
        return Boolean(this.manager)
    }

    get ready() {
        return this.manager?.state === 'warm' && Boolean(this.manager.activeBuffer)
    }

    start() {
        if (this.manager) return
        const manager = this.createManager({
            ...this.managerOptions,
            createSession: () => createRingWarmSession({
                requestTicket: () => this.requestTicket(),
                openSession: ticket => this.openSession(ticket),
                onLog: message => this.post('log_info', { data: message })
            })
        })
        this.manager = manager
        manager.on('state', status => this.reportState(status))
        manager.on('degraded', status => {
            this.post('log_error', { data: `Warm session degraded after ${status.consecutiveFailures} consecutive failures` })
            this.reportState(status)
        })
        manager.on('recovered', status => this.reportState(status))
        manager.on('session-failed', info => this.post('log_info', { data: `Warm session ${info.id} failed: ${info.reason}` }))
        this.reportState(manager.status())
        manager.start()
    }

    stop() {
        const manager = this.manager
        if (!manager) return
        this.manager = null
        manager.stop()
        for (const [, request] of this.ticketRequests) {
            this.clearTimer(request.timer)
            request.reject(new Error('Warm session stopped while waiting for a ticket'))
        }
        this.ticketRequests.clear()
        this.reportState({ state: 'stopped', enabled: false })
    }

    reportState(status) {
        this.post('warm_state', { status: { enabled: this.enabled, ...status }, ready: this.ready })
    }

    requestTicket() {
        const requestId = ++this.ticketSequence
        return new Promise((resolve, reject) => {
            const timer = this.setTimer(() => {
                this.ticketRequests.delete(requestId)
                reject(new Error(`Main thread did not answer the warm ticket request within ${TICKET_REQUEST_TIMEOUT_MS} ms`))
            }, TICKET_REQUEST_TIMEOUT_MS)
            this.ticketRequests.set(requestId, { resolve, reject, timer })
            this.post('warm_ticket_request', { requestId })
        })
    }

    handleTicket({ requestId, ticket, error }) {
        const request = this.ticketRequests.get(requestId)
        if (!request) return
        this.ticketRequests.delete(requestId)
        this.clearTimer(request.timer)
        if (error || !ticket) request.reject(new Error(error || 'Empty warm ticket'))
        else request.resolve(ticket)
    }

    // Runs a burst from the warm buffer. A source that is not usable right now is reported as
    // `fallback: 'cold'`, so the main thread can fall back to a dedicated session.
    async burst({ burstId, options }) {
        if (!this.manager) throw Object.assign(new WarmSourceUnavailableError('Warm mode is not enabled'), { fallback: 'cold' })
        try {
            return await this.captureFromWarm({ warm: this.manager, burstId, options })
        } catch (error) {
            if (error instanceof WarmSourceUnavailableError) error.fallback = 'cold'
            throw error
        }
    }
}
