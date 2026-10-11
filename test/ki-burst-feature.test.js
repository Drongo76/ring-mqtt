import test from 'node:test'
import assert from 'node:assert/strict'
import KiBurstFeature from '../lib/ki-burst-feature.js'

function makeHarness({ motionActive = true, lastDing = 1789019645 } = {}) {
    const calls = []
    const published = []
    const camera = {
        entity: {},
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
    return { feature, camera, calls, published, controller, controllerOptions, worker }
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
