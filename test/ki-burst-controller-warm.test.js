import test from 'node:test'
import assert from 'node:assert/strict'
import { KiBurstController } from '../lib/ki-burst-controller.js'

function makeController() {
    const sent = []
    const states = []
    const fallbacks = []
    let tickets = 0
    const controller = new KiBurstController({
        requestTicket: async () => { tickets++; return 'ticket-1' },
        sendWorker: message => sent.push(message),
        onState: (status, details) => states.push({ status, ...details }),
        onFallback: (burstId, reason) => fallbacks.push({ burstId, reason }),
        setTimer: () => 'timer',
        clearTimer: () => {}
    })
    return { controller, sent, states, fallbacks, tickets: () => tickets }
}

test('a warm burst skips the preflight stop and the ticket round trip', async () => {
    const { controller, sent, tickets } = makeController()
    const burstId = await controller.start({ source: 'warm', preRollMs: 3000 })
    assert.ok(burstId)
    assert.equal(tickets(), 0)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].command, 'burst')
    assert.equal(sent[0].source, 'warm')
    assert.equal(sent[0].options.preRollMs, 3000)
    assert.equal(sent[0].streamData, undefined)
})

test('a cold burst still stops the live worker first and carries a ticket', async () => {
    const { controller, sent, tickets } = makeController()
    await controller.start({})
    assert.equal(tickets(), 1)
    assert.deepEqual(sent.map(message => message.command), ['stop', 'burst'])
    assert.equal(sent[1].streamData.ticket, 'ticket-1')
    assert.equal(sent[1].source, undefined)
})

test('a warm source that is unusable falls back to a dedicated session for the same burst', async () => {
    const { controller, sent, states, fallbacks, tickets } = makeController()
    const burstId = await controller.start({ source: 'warm' })
    sent.length = 0
    const handled = controller.handleWorkerMessage({ type: 'burst_failed', burstId, error: 'No warm video source is available', fallback: 'cold' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(handled, true)
    assert.deepEqual(fallbacks, [{ burstId, reason: 'No warm video source is available' }])
    assert.deepEqual(sent.map(message => message.command), ['stop', 'burst'])
    assert.equal(sent[1].burstId, burstId)
    assert.equal(sent[1].streamData.ticket, 'ticket-1')
    assert.equal(tickets(), 1)
    assert.equal(states.some(state => state.status === 'failed'), false, 'a fallback is not a failure')
    assert.equal(controller.running, true)
})

test('a failure without a fallback marker still fails the burst', async () => {
    const { controller, states } = makeController()
    const burstId = await controller.start({ source: 'warm' })
    controller.handleWorkerMessage({ type: 'burst_failed', burstId, error: 'decoder died', fallback: null })
    assert.equal(states.at(-1).status, 'failed')
    assert.equal(controller.running, false)
})

test('a failed fallback ticket request fails the burst', async () => {
    const sent = []
    const states = []
    const controller = new KiBurstController({
        requestTicket: async () => { throw new Error('Ring unreachable') },
        sendWorker: message => sent.push(message),
        onState: (status, details) => states.push({ status, ...details }),
        setTimer: () => 'timer',
        clearTimer: () => {}
    })
    const burstId = await controller.start({ source: 'warm' })
    controller.handleWorkerMessage({ type: 'burst_failed', burstId, error: 'x', fallback: 'cold' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(states.at(-1).status, 'failed')
    assert.match(states.at(-1).error, /Ring unreachable/)
})

test('completion reports the source, pre-roll and replayed units', async () => {
    const { controller, states } = makeController()
    const burstId = await controller.start({ source: 'warm' })
    controller.handleWorkerMessage({
        type: 'burst_complete',
        burstId,
        frames: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')],
        source: 'warm',
        preRollMs: 3000,
        replayedUnits: 61
    })
    const complete = states.at(-1)
    assert.equal(complete.status, 'complete')
    assert.equal(complete.source, 'warm')
    assert.equal(complete.preRollMs, 3000)
    assert.equal(complete.replayedUnits, 61)
})

test('a completion without source information is reported as cold', async () => {
    const { controller, states } = makeController()
    const burstId = await controller.start({})
    controller.handleWorkerMessage({ type: 'burst_complete', burstId, frames: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')] })
    assert.equal(states.at(-1).source, 'cold')
    assert.equal(states.at(-1).preRollMs, null)
})
