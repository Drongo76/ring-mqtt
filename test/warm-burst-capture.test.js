import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessUnitBuffer } from '../lib/streaming/access-unit-buffer.js'
import { captureBurstFromWarmSource, WarmSourceUnavailableError } from '../lib/streaming/warm-burst-capture.js'
import { ffmpegPath, sleep, freeUdpPort, collectRtpFixture } from './helpers/rtp-fixture.js'

// build12-streaming-session.js pulls in rxjs, which is not needed here: the SDP helper is passed in.
const videoOnlySdp = (sdp, port) => sdp.replace(/m=video \d+/, `m=video ${port}`)

const T0 = 1_000_000

function makeSource(fixture) {
    const listeners = new Set()
    const ended = new Set()
    return {
        sdp: Promise.resolve(fixture.sdp),
        onAccessUnit: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        onEnded: listener => { ended.add(listener); return () => ended.delete(listener) },
        rtpIntegrity: () => ({ acceptedAccessUnits: 1 }),
        emit: unit => { for (const listener of [...listeners]) listener(unit) },
        end: () => { for (const listener of [...ended]) listener() },
        listenerCount: () => listeners.size + ended.size
    }
}

async function setup(t, { preBuffered = 20 } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'warm-capture-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const fixture = await collectRtpFixture(dir)
    const buffer = new AccessUnitBuffer({ now: () => T0 + preBuffered * 50 })
    fixture.units.slice(0, preBuffered).forEach((unit, index) => {
        buffer.push({ timestamp: unit.timestamp, keyframe: unit.keyframe, packets: unit.packets, receivedAtMs: T0 + index * 50 })
    })
    const source = makeSource(fixture)
    const warm = { activeBuffer: buffer, activeSession: source }
    const sender = dgram.createSocket('udp4')
    t.after(() => { try { sender.close() } catch {} })
    const sent = []
    const common = {
        warm,
        burstId: 'warm-test',
        cameraId: 7,
        outputDir: dir,
        ffmpegPath,
        reservePort: freeUdpPort,
        sendPacket: (port, packet) => {
            sent.push(packet)
            return new Promise((resolve, reject) => sender.send(packet, port, '127.0.0.1', error => error ? reject(error) : resolve()))
        },
        getVideoOnlySdp: videoOnlySdp,
        options: { minSeparationMs: 50, observationWindowMs: 600, hardSafetyTimeoutMs: 8000 },
        preRollMs: 3000,
        now: () => T0 + preBuffered * 50
    }
    return { fixture, buffer, source, warm, sent, common, dir }
}

const sequenceOf = packet => packet.readUInt16BE(2)

test('buffered pre-roll then live units form one continuous stream with in-order delivery', { timeout: 20000 }, async t => {
    const { fixture, source, common, sent } = await setup(t)
    const capture = captureBurstFromWarmSource(common)
    await sleep(300)
    for (const unit of fixture.units.slice(20)) {
        source.emit({ timestamp: unit.timestamp, keyframe: unit.keyframe, packets: unit.packets })
        await sleep(5)
    }
    const result = await capture

    assert.equal(result.source, 'warm')
    assert.equal(result.frames.length, 3)
    assert.equal(result.replayedUnits, 20)
    assert.ok(result.framePtsTime[0] < 1.0, 'first frame must come from the replayed pre-roll')

    const sequences = sent.map(sequenceOf)
    for (let i = 1; i < sequences.length; i++) {
        assert.equal((sequences[i] - sequences[i - 1] + 65536) % 65536, 1, `gap or reorder at packet ${i}`)
    }
    assert.equal(source.listenerCount(), 0, 'listeners must be released')
})

test('live units that arrive while the pre-roll is still replaying are delivered after it, not lost', { timeout: 20000 }, async t => {
    const { fixture, source, common, sent } = await setup(t)
    // A slow replay keeps the capture in its replay phase while live units already arrive.
    const capture = captureBurstFromWarmSource({ ...common, replayChunkUnits: 1, replayChunkDelayMs: 15 })
    await sleep(60)
    for (const unit of fixture.units.slice(20)) source.emit({ timestamp: unit.timestamp, keyframe: unit.keyframe, packets: unit.packets })
    const result = await capture
    assert.equal(result.frames.length, 3)
    const expectedPackets = fixture.units.reduce((total, unit) => total + unit.packets.length, 0)
    assert.equal(sent.length, expectedPackets, 'every packet of every unit must reach the decoder exactly once')
    const sequences = sent.map(sequenceOf)
    for (let i = 1; i < sequences.length; i++) assert.equal((sequences[i] - sequences[i - 1] + 65536) % 65536, 1)
})

test('without a warm source the capture fails fast with a distinguishable error', async () => {
    await assert.rejects(captureBurstFromWarmSource({ warm: { activeBuffer: null, activeSession: null } }), WarmSourceUnavailableError)
    const empty = { activeBuffer: new AccessUnitBuffer(), activeSession: makeSource({ sdp: '' }) }
    await assert.rejects(captureBurstFromWarmSource({ warm: empty, now: () => 0 }), /buffer is empty/)
})

test('the pre-roll window starts at a keyframe at or before now minus preRollMs', { timeout: 20000 }, async t => {
    const { source, common, buffer } = await setup(t)
    let replayed = null
    const capture = captureBurstFromWarmSource({
        ...common,
        // 400 ms of pre-roll, keyframes every 10 units = 500 ms apart.
        preRollMs: 400,
        emit: (stage, details) => { if (stage === 'warm_replay_started') replayed = details }
    })
    await sleep(100)
    source.end()
    await capture.catch(() => {})
    assert.ok(replayed, 'replay must have started')
    const expected = buffer.extractFrom(common.now() - 400)
    assert.equal(replayed.units, expected.units.length)
    assert.ok(expected.units[0].keyframe)
    assert.ok(replayed.units < 20, 'must not replay the whole buffer')
})

test('the warm source ending during capture stops the analysis and fails with a clear reason', { timeout: 20000 }, async t => {
    const { source, common } = await setup(t, { preBuffered: 10 })
    const capture = captureBurstFromWarmSource(common)
    await sleep(200)
    source.end()
    await assert.rejects(capture, error => {
        assert.equal(error.kiBurstDiagnostics?.stopReason, 'warm-source-ended')
        return true
    })
    assert.equal(source.listenerCount(), 0)
})

test('a failing decoder port reservation releases the live subscription', async t => {
    const { source, common } = await setup(t)
    await assert.rejects(captureBurstFromWarmSource({ ...common, reservePort: async () => { throw new Error('no ports') } }), /no ports/)
    assert.equal(source.listenerCount(), 0)
})
