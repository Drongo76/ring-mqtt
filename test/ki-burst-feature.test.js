import test from 'node:test'
import assert from 'node:assert/strict'
import KiBurstFeature from '../lib/ki-burst-feature.js'

function makeHarness({ motionActive = true, lastDing = 1789019645, savedState = {} } = {}) {
    const calls = []
    const published = []
    const camera = {
        entity: {},
        saved: 0,
        getSavedState: () => savedState,
        updateDeviceState: () => { camera.saved++ },
        data: { motion: { active_ding: motionActive, last_ding: lastDing } },
        debug: message => calls.push(['debug', String(message)]),
        mqttPublish: (topic, payload) => published.push({ topic, payload })
    }
    const liveControl = {
        yieldToBurst: () => calls.push(['yield']),
        requestTicket: async () => 'ticket-xyz'
    }
    const controllerOptions = {}
    const controller = {
        running: false,
        start: async options => { calls.push(['start', options]); controller.running = true; return 'burst-1' },
        handleWorkerMessage: message => message.type === 'burst',
        cancel: reason => calls.push(['cancel', reason])
    }
    const feature = new KiBurstFeature(camera, {
        liveControl,
        outputDir: '/tmp/ki',
        createController: options => { Object.assign(controllerOptions, options); return controller }
    })
    const worker = { posted: [], postMessage: message => worker.posted.push(message) }
    feature.attachWorker(worker)
    return { feature, camera, calls, published, controller, controllerOptions, worker, liveControl }
}

test('registers the button, three frame cameras and the status sensor', () => {
    const { camera } = makeHarness()
    assert.equal(camera.entity.ki_burst.component, 'button')
    for (const key of ['ki_burst_frame_1', 'ki_burst_frame_2', 'ki_burst_frame_3']) assert.equal(camera.entity[key].component, 'camera')
    assert.equal(camera.entity.ki_burst_status.component, 'sensor')
    assert.equal(camera.entity.ki_burst_status.attributes, true)
    assert.equal(camera.data.ki_burst.status, 'idle')
})

test('press takes the live worker offline first, then starts the burst with the motion timestamp', async () => {
    const { feature, camera, calls } = makeHarness()
    assert.equal(await feature.take(), true)
    assert.deepEqual(calls.map(call => call[0]), ['yield', 'start'])
    assert.equal(camera.data.ki_burst.motionEventTimestamp, 1789019645)
    const options = calls[1][1]
    assert.equal(options.outputDir, '/tmp/ki')
    assert.equal(options.frameCount, 3)
})

test('a burst without an active motion event carries no motion timestamp', async () => {
    const { feature, camera } = makeHarness({ motionActive: false })
    await feature.take()
    assert.equal(camera.data.ki_burst.motionEventTimestamp, null)
})

test('a second request while a burst is running is ignored and does not touch the live session', async () => {
    const { feature, calls } = makeHarness()
    await feature.take()
    calls.length = 0
    assert.equal(await feature.take(), false)
    assert.deepEqual(calls.map(call => call[0]), ['debug'])
    assert.equal(feature.running, true)
})

test('only the press command starts a burst', async () => {
    const { feature, calls } = makeHarness()
    feature.handleCommand('PRESS')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(calls.some(call => call[0] === 'start'))
    calls.length = 0
    feature.handleCommand('bogus')
    assert.deepEqual(calls.map(call => call[0]), ['debug'])
})

test('the controller gets its ticket from the live control and sends to the shared worker', async () => {
    const { controllerOptions, worker } = makeHarness()
    assert.equal(await controllerOptions.requestTicket(), 'ticket-xyz')
    controllerOptions.sendWorker({ command: 'x' })
    assert.deepEqual(worker.posted, [{ command: 'x' }])
})

test('a missing Ring ticket is an error for the burst', async () => {
    const harness = makeHarness()
    const { controllerOptions } = harness
    // Rebuild with a live control that returns no ticket.
    const feature = new KiBurstFeature(harness.camera, {
        liveControl: { requestTicket: async () => undefined, yieldToBurst() {} },
        createController: options => Object.assign(harness.controller, { options })
    })
    feature.attachWorker({ postMessage() {} })
    await assert.rejects(harness.controller.options.requestTicket(), /did not return a WebRTC signaling ticket/)
    assert.ok(controllerOptions)
})

test('worker messages are offered to the controller and a worker crash cancels the burst', () => {
    const { feature, calls } = makeHarness()
    assert.equal(feature.handleWorkerMessage({ type: 'burst' }), true)
    assert.equal(feature.handleWorkerMessage({ type: 'state' }), false)
    feature.handleWorkerCrash()
    assert.deepEqual(calls.at(-1), ['cancel', 'Live worker crashed'])
})

test('republish re-emits status, attributes and stored frames without recomputing', () => {
    const { feature, camera, published } = makeHarness()
    camera.entity.ki_burst_status.state_topic = 'status'
    camera.entity.ki_burst_status.json_attributes_topic = 'status/attr'
    camera.entity.ki_burst_frame_2.topic = 'frame/2'
    camera.data.ki_burst.status = 'complete'
    camera.data.ki_burst.attributes = { status: 'complete', frameCount: 3 }
    camera.data.ki_burst.frames = [null, Buffer.from('F2'), null]
    feature.republish()
    assert.deepEqual(published.map(entry => entry.topic), ['status', 'status/attr', 'frame/2'])
    assert.equal(JSON.parse(published[1].payload).frameCount, 3)
})

test('the warm switch is off by default and restored from the saved state', () => {
    assert.equal(makeHarness().camera.data.ki_burst_warm.state, 'OFF')
    const restored = makeHarness({ savedState: { ki_burst_warm: { state: 'ON' } } })
    assert.equal(restored.camera.data.ki_burst_warm.state, 'ON')
    assert.deepEqual(restored.worker.posted, [{ command: 'warm_start' }], 'a restored ON state starts the warm source')
    assert.equal(makeHarness().worker.posted.length, 0)
})

test('switching warm mode on and off drives the worker, persists and publishes the switch', () => {
    const { feature, camera, worker, published } = makeHarness()
    camera.entity.ki_burst_warm.state_topic = 'warm/state'
    feature.handleWarmCommand('ON')
    assert.deepEqual(worker.posted.at(-1), { command: 'warm_start' })
    assert.equal(camera.data.ki_burst_warm.state, 'ON')
    assert.deepEqual(feature.persistedState(), { state: 'ON' })
    assert.equal(camera.saved, 1)
    assert.deepEqual(published.at(-1), { topic: 'warm/state', payload: 'ON' })
    feature.handleWarmCommand('off')
    assert.deepEqual(worker.posted.at(-1), { command: 'warm_stop' })
    assert.equal(feature.warmReady, false)
    assert.deepEqual(published.at(-1), { topic: 'warm/state', payload: 'OFF' })
})

test('an invalid warm command changes nothing', () => {
    const { feature, camera, worker } = makeHarness()
    feature.handleWarmCommand('maybe')
    assert.equal(camera.data.ki_burst_warm.state, 'OFF')
    assert.equal(worker.posted.length, 0)
})

test('a ready warm source starts a warm burst without touching the live session', async () => {
    const { feature, calls } = makeHarness()
    feature.handleWorkerMessage({ type: 'warm_state', ready: true, status: { enabled: true, state: 'warm' } })
    assert.equal(feature.warmReady, true)
    await feature.take()
    assert.deepEqual(calls.map(call => call[0]), ['start'])
    assert.equal(calls[0][1].source, 'warm')
    assert.equal(calls[0][1].preRollMs, 3000)
})

test('without a ready warm source the burst runs cold and the live worker steps aside', async () => {
    const { feature, calls } = makeHarness()
    feature.handleWorkerMessage({ type: 'warm_state', ready: false, status: { enabled: true, state: 'starting' } })
    await feature.take()
    assert.deepEqual(calls.map(call => call[0]), ['yield', 'start'])
    assert.equal(calls[1][1].source, 'cold')
})

test('a warm fallback makes the live worker step aside before the dedicated session starts', () => {
    const { controllerOptions, calls } = makeHarness()
    controllerOptions.onFallback('b1', 'No warm video source is available')
    assert.deepEqual(calls.map(call => call[0]), ['debug', 'yield'])
})

test('warm state messages are claimed and published as compact status attributes', () => {
    const { feature, camera, published } = makeHarness()
    camera.entity.ki_burst_status.json_attributes_topic = 'status/attr'
    const claimed = feature.handleWorkerMessage({
        type: 'warm_state',
        ready: true,
        status: { enabled: true, state: 'warm', rotations: 2, buffer: { gopCount: 4, unitCount: 160, bytes: 900000, oldestStartAgeMs: 7000, newestAgeMs: 30, secret: 'x' } }
    })
    assert.equal(claimed, true)
    const attributes = JSON.parse(published.at(-1).payload)
    assert.equal(attributes.warm.ready, true)
    assert.equal(attributes.warm.rotations, 2)
    assert.deepEqual(Object.keys(attributes.warm.buffer).sort(), ['bytes', 'gopCount', 'newestAgeMs', 'oldestStartAgeMs', 'unitCount'])
})

test('ticket requests from the warm worker are answered through the live control', async () => {
    const { feature, worker } = makeHarness()
    assert.equal(feature.handleWorkerMessage({ type: 'warm_ticket_request', requestId: 7 }), true)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(worker.posted.at(-1), { command: 'warm_ticket', requestId: 7, ticket: 'ticket-xyz' })
})

test('a failing ticket request is reported back to the worker as an error', async () => {
    const { feature, worker, liveControl } = makeHarness()
    liveControl.requestTicket = async () => { throw new Error('Ring said no') }
    feature.handleWorkerMessage({ type: 'warm_ticket_request', requestId: 8 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(worker.posted.at(-1), { command: 'warm_ticket', requestId: 8, error: 'Ring said no' })
})
