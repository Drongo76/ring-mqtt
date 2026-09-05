import test from 'node:test'
import assert from 'node:assert/strict'
import { KiBurstController, normalizeBurstFrames } from '../lib/ki-burst-controller.js'
import { buildBurstFfmpegArgs } from '../lib/streaming/build12-streaming-session.js'
import { homeAssistantSlug } from '../lib/build12-patch.js'
import Camera from '../devices/camera.js'

function makeController({ timeoutMs = 12000 } = {}) {
    const sent = []
    const states = []
    let ticketRequests = 0
    let timeoutCallback = null
    const controller = new KiBurstController({
        requestTicket: async () => {
            ticketRequests++
            return 'ticket-1'
        },
        sendWorker: message => sent.push(message),
        onState: (state, details) => states.push({ state, details }),
        timeoutMs,
        setTimer: callback => {
            timeoutCallback = callback
            return { id: 1 }
        },
        clearTimer: () => { timeoutCallback = null }
    })
    return {
        controller,
        sent,
        states,
        get ticketRequests() { return ticketRequests },
        fireTimeout: () => timeoutCallback?.()
    }
}

test('KI Burst opens exactly one dedicated burst session and completes with exactly three sequential frames', async () => {
    const fixture = makeController()
    const burstId = await fixture.controller.start()

    assert.equal(fixture.ticketRequests, 1)
    assert.equal(fixture.sent.filter(message => message.command === 'burst').length, 1)
    assert.deepEqual(fixture.sent.map(message => message.command), ['stop', 'burst'])

    const frames = [Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('frame-3')]
    const handled = fixture.controller.handleWorkerMessage({
        type: 'burst_complete',
        burstId,
        frames,
        paths: ['/data/1.jpg', '/data/2.jpg', '/data/3.jpg'],
        intervalMs: 800,
        frameOffsetsMs: [0, 800, 1600],
        capturedAt: '2026-09-05T15:00:00.000Z'
    })

    assert.equal(handled, true)
    assert.equal(fixture.controller.running, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'complete'])
    assert.equal(fixture.states.at(-1).details.frames.length, 3)
    assert.deepEqual(fixture.states.at(-1).details.frameOffsetsMs, [0, 800, 1600])
    assert.equal(fixture.sent.some(message => message.command === 'start'), false, 'burst completion must never restart regular live')
})

test('KI Burst timeout stops the worker and cannot be resurrected by a late completion callback', async () => {
    const fixture = makeController({ timeoutMs: 100 })
    const burstId = await fixture.controller.start()

    fixture.fireTimeout()
    assert.equal(fixture.controller.running, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'failed'])
    assert.deepEqual(fixture.sent.map(message => message.command), ['stop', 'burst', 'stop'])

    const lateHandled = fixture.controller.handleWorkerMessage({
        type: 'burst_complete',
        burstId,
        frames: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]
    })
    assert.equal(lateHandled, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'failed'])
    assert.equal(fixture.ticketRequests, 1)
})

test('KI Burst rejects incomplete worker output instead of publishing a partial burst', async () => {
    const fixture = makeController()
    const burstId = await fixture.controller.start()

    fixture.controller.handleWorkerMessage({
        type: 'burst_complete',
        burstId,
        frames: [Buffer.from('frame-1'), Buffer.from('frame-2')]
    })

    assert.equal(fixture.controller.running, false)
    assert.deepEqual(fixture.states.map(entry => entry.state), ['capturing', 'failed'])
    assert.equal(fixture.states.at(-1).details.error.includes('exactly 3 frames'), true)
    assert.equal(fixture.sent.at(-1).command, 'stop')
})

test('burst frame normalization accepts worker Uint8Array payloads and preserves exactly three frames', () => {
    const frames = normalizeBurstFrames([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
        new Uint8Array([7, 8, 9])
    ])
    assert.equal(frames.length, 3)
    assert.deepEqual(frames.map(frame => [...frame]), [[1, 2, 3], [4, 5, 6], [7, 8, 9]])
})

test('burst ffmpeg arguments produce three JPEGs at 1.25 fps (0 / 0.8 / 1.6 s)', () => {
    const args = buildBurstFfmpegArgs({
        intervalMs: 800,
        frameCount: 3,
        outputPattern: '/tmp/frame-%d.jpg'
    })

    assert.equal(args.includes('setpts=PTS-STARTPTS,fps=1.25'), true)
    assert.equal(args[args.indexOf('-frames:v') + 1], '3')
    assert.equal(args.at(-1), '/tmp/frame-%d.jpg')
})


test('Home Assistant still-image slug handles umlauts such as Haustür', () => {
    assert.equal(homeAssistantSlug('Haustür'), 'haustur')
    assert.equal(homeAssistantSlug('Vordere Tür Kamera'), 'vordere_tur_kamera')
})

test('snapshot mode validation rejects values outside the configured options', () => {
    const camera = Object.create(Camera.prototype)
    camera.entity = { snapshot_mode: { options: ['Auto', 'Motion', 'Disabled'] } }
    camera.data = {
        snapshot: { mode: 'Auto', autoInterval: true, intervalTimerId: null }
    }
    camera.debug = () => {}
    camera.updateSnapshotMode = () => { camera.updated = true }
    camera.publishSnapshotMode = () => { camera.published = true }
    camera.updateDeviceState = () => { camera.saved = true }
    camera.scheduleSnapshotRefresh = () => {}
    camera.publishSnapshotInterval = () => {}

    camera.setSnapshotMode('Definitely Invalid')

    assert.equal(camera.data.snapshot.mode, 'Auto')
    assert.equal(camera.updated, undefined)
    assert.equal(camera.published, undefined)
    assert.equal(camera.saved, undefined)
})
