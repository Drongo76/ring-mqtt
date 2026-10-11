import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import LiveStreamControl from '../lib/live-stream-control.js'

class FakeWorker extends EventEmitter {
    constructor() { super(); this.posted = [] }
    postMessage(message) { this.posted.push(message) }
    terminate() { this.terminated = true; return Promise.resolve() }
}

class FakeProcess extends EventEmitter {
    constructor() { super(); this.killed = [] }
    kill(signal) { this.killed.push(signal) }
}

function makeHarness({ liveAllow = 'ON', ticket = 'ticket-1', burstRunning = false, autoOff = {} } = {}) {
    const log = { debug: [], streamPublishes: [], liveAllowPublishes: 0, saved: 0, spawned: [], crashes: [] }
    const state = { burstRunning, ticket, ticketDelay: null }
    const camera = {
        deviceId: 'cam1',
        device: {
            restClient: {
                request: async () => {
                    if (state.ticketDelay) await state.ticketDelay
                    if (state.ticket instanceof Error) throw state.ticket
                    return { ticket: state.ticket }
                }
            }
        },
        data: {
            live_allow: { state: liveAllow },
            auto_off: { enabled: false, minutes: 2, timer: null, ...autoOff },
            stream: {
                live: { status: 'inactive', session: false, publishedStatus: '', pendingOnDemandUrl: null, pendingOnDemandAt: 0, worker: null },
                keepalive: { active: false, session: false, expires: 0 }
            }
        },
        debug: message => log.debug.push(String(message?.message || message)),
        publishStreamState: (...args) => log.streamPublishes.push(args),
        publishLiveAllowState: () => { log.liveAllowPublishes++ },
        updateDeviceState: () => { log.saved++ }
    }
    const workers = []
    const control = new LiveStreamControl(camera, {
        createWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
        spawnProcess: (path, args) => { const p = new FakeProcess(); log.spawned.push({ path, args, process: p }); return p },
        ffmpegPath: '/usr/bin/ffmpeg',
        getConfig: () => ({}),
        isBurstRunning: () => state.burstRunning,
        onWorkerCrash: error => log.crashes.push(error),
        interceptWorkerMessage: message => message.type === 'burst'
    })
    control.attachWorker()
    return { camera, control, log, state, workers, worker: workers[0] }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('ON-DEMAND with Live Allow ON requests a ticket and starts the worker with a request id', async () => {
    const { control, camera, worker } = makeHarness()
    control.setLiveStreamState('ON-DEMAND rtsp://localhost:8554/cam1_live')
    assert.equal(camera.data.stream.live.status, 'activating')
    await tick()
    assert.deepEqual(worker.posted.at(-1), {
        command: 'start',
        requestId: 1,
        streamData: { rtspPublishUrl: 'rtsp://localhost:8554/cam1_live', ticket: 'ticket-1' }
    })
})

test('ON-DEMAND is refused while Live Allow is OFF and no stale URL is remembered', async () => {
    const { control, camera, worker } = makeHarness({ liveAllow: 'OFF' })
    control.setLiveStreamState('ON-DEMAND rtsp://x')
    await tick()
    assert.equal(worker.posted.length, 0)
    assert.equal(camera.data.stream.live.pendingOnDemandUrl, null)
    assert.equal(camera.data.stream.live.status, 'inactive')
})

test('ON-DEMAND is refused while a KI Burst owns the WebRTC session', async () => {
    const { control, worker } = makeHarness({ burstRunning: true })
    control.setLiveStreamState('ON-DEMAND rtsp://x')
    await tick()
    assert.equal(worker.posted.length, 0)
})

test('a ticket that arrives after Live Allow was switched OFF is discarded', async () => {
    const harness = makeHarness()
    let release
    harness.state.ticketDelay = new Promise(resolve => { release = resolve })
    harness.control.setLiveStreamState('ON-DEMAND rtsp://x')
    harness.control.setLiveAllowState('off')
    release()
    await tick()
    await tick()
    assert.equal(harness.worker.posted.some(message => message.command === 'start'), false)
    assert.ok(harness.log.debug.some(text => /Discarding stale live ticket/.test(text)))
})

test('a ticket for a request replaced by a newer one never reaches the worker', async () => {
    const harness = makeHarness()
    let release
    harness.state.ticketDelay = new Promise(resolve => { release = resolve })
    const first = harness.control.startLiveStream('rtsp://first')
    harness.state.ticketDelay = null
    const second = harness.control.startLiveStream('rtsp://second')
    release()
    await Promise.all([first, second])
    const starts = harness.worker.posted.filter(message => message.command === 'start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].streamData.rtspPublishUrl, 'rtsp://second')
})

test('missing ticket marks the live stream failed', async () => {
    const harness = makeHarness({ ticket: null })
    await harness.control.startLiveStream('rtsp://x')
    assert.equal(harness.camera.data.stream.live.status, 'failed')
    assert.equal(harness.worker.posted.length, 0)
})

test('worker state callbacks of an older request are ignored, current ones apply', async () => {
    const { control, camera, worker } = makeHarness()
    await control.startLiveStream('rtsp://x')
    worker.emit('message', { type: 'state', kind: 'live', requestId: 99, data: 'active' })
    assert.equal(camera.data.stream.live.status, 'inactive')
    worker.emit('message', { type: 'state', kind: 'live', requestId: 1, data: 'active' })
    assert.equal(camera.data.stream.live.status, 'active')
    assert.equal(camera.data.stream.live.session, true)
    worker.emit('message', { type: 'state', kind: 'live', requestId: 1, data: 'inactive' })
    assert.equal(camera.data.stream.live.status, 'inactive')
    assert.equal(control.activeRequestId, null)
})

test('messages claimed by the interceptor never reach the live state machine', () => {
    const { camera, worker, log } = makeHarness()
    const before = log.streamPublishes.length
    worker.emit('message', { type: 'burst' })
    assert.equal(log.streamPublishes.length, before)
    assert.equal(camera.data.stream.live.status, 'inactive')
})

test('Live Allow ON starts the keepalive reader, OFF kills it and stops the worker', () => {
    const { control, camera, worker, log } = makeHarness({ liveAllow: 'OFF' })
    control.setLiveAllowState('on')
    assert.equal(camera.data.live_allow.state, 'ON')
    assert.equal(log.spawned.length, 1)
    assert.equal(log.spawned[0].path, '/usr/bin/ffmpeg')
    assert.ok(log.spawned[0].args.includes('rtsp://localhost:8554/cam1_live'))
    assert.equal(camera.data.stream.keepalive.active, true)

    control.setLiveAllowState('off')
    assert.deepEqual(log.spawned[0].process.killed, ['SIGTERM'])
    assert.equal(camera.data.stream.keepalive.active, false)
    assert.deepEqual(worker.posted.at(-1), { command: 'stop', reason: 'live-allow-off' })
    assert.equal(camera.data.stream.live.status, 'inactive')
    clearTimeout(camera.data.stream.keepalive.timer)
})

test('keepalive credentials from configuration are used in the RTSP URL', () => {
    const harness = makeHarness()
    harness.control.getConfig = () => ({ livestream_user: 'u', livestream_pass: 'p' })
    harness.control.startKeepaliveStream()
    assert.ok(harness.log.spawned[0].args.includes('rtsp://u:p@localhost:8554/cam1_live'))
    harness.control.stopKeepalive()
})

test('keepalive is not started while Live Allow is OFF, a burst runs, or one is already active', () => {
    const off = makeHarness({ liveAllow: 'OFF' })
    off.control.startKeepaliveStream()
    assert.equal(off.log.spawned.length, 0)

    const burst = makeHarness({ burstRunning: true })
    burst.control.startKeepaliveStream()
    assert.equal(burst.log.spawned.length, 0)

    const twice = makeHarness()
    twice.control.startKeepaliveStream()
    twice.control.startKeepaliveStream()
    assert.equal(twice.log.spawned.length, 1)
    twice.control.stopKeepalive()
})

test('a close event of a replaced keepalive process cannot clear the new one', () => {
    const { control, camera, log } = makeHarness()
    control.startKeepaliveStream()
    const first = log.spawned[0].process
    control.stopKeepalive()
    control.startKeepaliveStream()
    first.emit('close')
    assert.equal(camera.data.stream.keepalive.active, true)
    assert.equal(camera.data.stream.keepalive.session, log.spawned[1].process)
    log.spawned[1].process.emit('close')
    assert.equal(camera.data.stream.keepalive.active, false)
    control.stopKeepalive()
})

test('yieldToBurst stops keepalive and worker and invalidates the pending request', () => {
    const { control, camera, worker, log } = makeHarness()
    control.startKeepaliveStream()
    const generation = control.requestGeneration
    control.yieldToBurst()
    assert.deepEqual(log.spawned[0].process.killed, ['SIGTERM'])
    assert.deepEqual(worker.posted.at(-1), { command: 'stop', reason: 'ki-burst-preflight' })
    assert.ok(control.requestGeneration > generation)
    assert.equal(camera.data.stream.live.status, 'inactive')
})

test('auto-off switches Live Allow OFF after the configured time', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const harness = makeHarness({ autoOff: { enabled: true, minutes: 2 } })
    harness.camera.data.stream.live.status = 'active'
    harness.control.rescheduleAutoOff()
    assert.ok(harness.camera.data.auto_off.timer)
    t.mock.timers.tick(2 * 60 * 1000 - 1)
    assert.equal(harness.camera.data.live_allow.state, 'ON')
    t.mock.timers.tick(1)
    assert.equal(harness.camera.data.live_allow.state, 'OFF')
    assert.equal(harness.camera.data.auto_off.timer, null)
})

test('auto-off is not scheduled when disabled, when Live Allow is OFF, or when nothing is live', () => {
    const disabled = makeHarness()
    disabled.camera.data.stream.live.status = 'active'
    disabled.control.rescheduleAutoOff()
    assert.equal(disabled.camera.data.auto_off.timer, null)

    const idle = makeHarness({ autoOff: { enabled: true } })
    idle.control.rescheduleAutoOff()
    assert.equal(idle.camera.data.auto_off.timer, null)
})

test('a worker crash fails the active request and notifies the owner', () => {
    const { control, camera, worker, log } = makeHarness()
    control.activeRequestId = 5
    camera.data.stream.live.status = 'active'
    worker.emit('error', new Error('boom'))
    assert.equal(camera.data.stream.live.status, 'failed')
    assert.equal(control.activeRequestId, null)
    assert.equal(log.crashes.length, 1)
})

test('replacing the worker detaches and stops the previous one', () => {
    const { control, workers } = makeHarness()
    control.attachWorker()
    assert.equal(workers.length, 2)
    assert.deepEqual(workers[0].posted.at(-1), { command: 'stop', reason: 'worker-replace' })
    assert.equal(workers[0].terminated, true)
    assert.equal(workers[0].listenerCount('message'), 0)
})
