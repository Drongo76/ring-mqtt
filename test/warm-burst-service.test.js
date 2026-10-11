import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WarmBurstService, TICKET_REQUEST_TIMEOUT_MS } from '../lib/warm-burst-service.js'
import { WarmSourceUnavailableError } from '../lib/streaming/warm-burst-capture.js'

class FakeManager extends EventEmitter {
    constructor(options) {
        super()
        this.options = options
        this.state = 'stopped'
        this.activeBuffer = null
        this.started = 0
        this.stopped = 0
    }
    start() { this.started++; this.state = 'starting' }
    stop() { this.stopped++; this.state = 'stopped' }
    status() { return { state: this.state, degraded: false } }
    becomeWarm() { this.state = 'warm'; this.activeBuffer = {}; this.emit('state', this.status()) }
}

function makeService(overrides = {}) {
    const posts = []
    const timers = []
    let manager
    const service = new WarmBurstService({
        post: (type, data) => posts.push({ type, ...data }),
        openSession: () => { throw new Error('not used') },
        captureFromWarm: async () => ({ frames: [] }),
        createManager: options => (manager = new FakeManager(options)),
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
        clearTimer: timer => { timer.cleared = true },
        ...overrides
    })
    return { service, posts, timers, manager: () => manager }
}

test('start creates and starts one manager, a second start does nothing', () => {
    const { service, manager } = makeService()
    service.start()
    service.start()
    assert.equal(manager().started, 1)
    assert.equal(service.enabled, true)
})

test('ready only when the manager is warm and has a buffer', () => {
    const { service, manager } = makeService()
    assert.equal(service.ready, false)
    service.start()
    assert.equal(service.ready, false)
    manager().becomeWarm()
    assert.equal(service.ready, true)
})

test('state changes are reported to the main thread with the ready flag', () => {
    const { service, posts, manager } = makeService()
    service.start()
    manager().becomeWarm()
    const last = posts.filter(post => post.type === 'warm_state').at(-1)
    assert.equal(last.ready, true)
    assert.equal(last.status.state, 'warm')
    assert.equal(last.status.enabled, true)
})

test('degradation is logged as an error and reported', () => {
    const { service, posts, manager } = makeService()
    service.start()
    manager().emit('degraded', { state: 'backoff', consecutiveFailures: 5 })
    assert.ok(posts.some(post => post.type === 'log_error' && /degraded after 5/.test(post.data)))
})

test('a ticket request goes to the main thread and is resolved by its answer', async () => {
    const { service, posts, manager } = makeService()
    service.start()
    const pending = manager().options.createSession({ id: 1 }).catch(error => error)
    const request = posts.find(post => post.type === 'warm_ticket_request')
    assert.ok(request)
    service.handleTicket({ requestId: request.requestId, error: 'Ring said no' })
    const outcome = await pending
    assert.match(outcome.message, /Ring said no/)
})

test('a resolved ticket opens the Ring session with that ticket', async () => {
    const opened = []
    const session = {
        connection: { onCallAnswered: { subscribe: () => ({ unsubscribe() {} }) } },
        onVideoRtp: { subscribe: () => ({ unsubscribe() {} }) },
        onCallEnded: { subscribe: () => ({ unsubscribe() {} }) },
        requestKeyFrame() {}, stop() {}
    }
    const { service, posts, manager } = makeService({ openSession: ticket => { opened.push(ticket); return session } })
    service.start()
    const pending = manager().options.createSession({ id: 1 })
    service.handleTicket({ requestId: posts.find(post => post.type === 'warm_ticket_request').requestId, ticket: 'TICKET-9' })
    const warm = await pending
    assert.deepEqual(opened, ['TICKET-9'])
    warm.stop()
})

test('an unanswered ticket request times out and releases its timer entry', async () => {
    const { service, timers, manager } = makeService()
    service.start()
    const pending = manager().options.createSession({ id: 1 }).catch(error => error)
    const timer = timers.find(entry => entry.ms === TICKET_REQUEST_TIMEOUT_MS)
    assert.ok(timer)
    timer.fn()
    const outcome = await pending
    assert.match(outcome.message, /did not answer the warm ticket request/)
    assert.equal(service.ticketRequests.size, 0)
})

test('a late or unknown ticket answer is ignored', () => {
    const { service } = makeService()
    service.start()
    assert.doesNotThrow(() => service.handleTicket({ requestId: 999, ticket: 'x' }))
})

test('stop tears the manager down, rejects waiting ticket requests and reports disabled', async () => {
    const { service, posts, manager } = makeService()
    service.start()
    const pending = manager().options.createSession({ id: 1 }).catch(error => error)
    const stoppedManager = manager()
    service.stop()
    assert.equal(stoppedManager.stopped, 1)
    assert.equal(service.enabled, false)
    assert.match((await pending).message, /stopped while waiting/)
    assert.equal(posts.filter(post => post.type === 'warm_state').at(-1).status.enabled, false)
    service.stop()
    assert.equal(stoppedManager.stopped, 1)
})

test('burst delegates to the capture function with the manager as warm source', async () => {
    let received
    const { service, manager } = makeService({ captureFromWarm: async args => { received = args; return { frames: ['f'] } } })
    service.start()
    const result = await service.burst({ burstId: 'b1', options: { x: 1 } })
    assert.deepEqual(result, { frames: ['f'] })
    assert.equal(received.warm, manager())
    assert.equal(received.burstId, 'b1')
})

test('a burst while warm mode is off asks for the cold fallback', async () => {
    const { service } = makeService()
    await assert.rejects(service.burst({ burstId: 'b' }), error => error.fallback === 'cold')
})

test('an unusable warm source is marked for cold fallback, other failures are not', async () => {
    const unavailable = makeService({ captureFromWarm: async () => { throw new WarmSourceUnavailableError('empty') } })
    unavailable.service.start()
    await assert.rejects(unavailable.service.burst({ burstId: 'b' }), error => error.fallback === 'cold')

    const broken = makeService({ captureFromWarm: async () => { throw new Error('decoder died') } })
    broken.service.start()
    await assert.rejects(broken.service.burst({ burstId: 'b' }), error => error.fallback === undefined && /decoder died/.test(error.message))
})
