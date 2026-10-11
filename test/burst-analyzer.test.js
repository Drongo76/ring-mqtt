import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import dgram from 'node:dgram'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BurstAnalyzer } from '../lib/streaming/burst-analyzer.js'
import { H264RtpFrameGate } from '../lib/streaming/h264-rtp-frame-gate.js'

const ffmpegPath = execSync('command -v ffmpeg').toString().trim()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freeUdpPort() {
    const socket = dgram.createSocket('udp4')
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    const { port } = socket.address()
    await new Promise(resolve => socket.close(resolve))
    return port
}

// Real H.264 over RTP from ffmpeg (moving test pattern, keyframe every 10 frames).
async function collectRtpFixture(dir, { seconds = 3 } = {}) {
    const socket = dgram.createSocket('udp4')
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    const packets = []
    socket.on('message', message => packets.push(Buffer.from(message)))
    const sdpPath = join(dir, 'source.sdp')
    const child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=20:duration=${seconds}`,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-x264-params', 'repeat-headers=1',
        '-payload_type', '96', '-f', 'rtp', '-sdp_file', sdpPath,
        `rtp://127.0.0.1:${socket.address().port}?pkt_size=1100`
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise(resolve => child.once('close', resolve))
    await sleep(100)
    socket.close()
    assert.equal(code, 0, stderr)
    const sdp = (await readFile(sdpPath, 'utf8')).replace(/(m=video[^\n]*\n)/, '$1c=IN IP4 127.0.0.1\n')
    // Group through the real gate so the units match what the production source produces.
    const gate = new H264RtpFrameGate()
    const units = []
    for (const packet of packets) {
        const result = gate.push(packet)
        if (result?.accepted) units.push(...(result.accessUnits || [result]))
    }
    gate.stop()
    assert.ok(units.length > 20, `expected access units, got ${units.length}`)
    assert.ok(units[0].keyframe)
    return { sdp, units }
}

async function makeAnalyzer(t, overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'burst-analyzer-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const fixture = await collectRtpFixture(dir)
    const port = await freeUdpPort()
    const sender = dgram.createSocket('udp4')
    t.after(() => { try { sender.close() } catch {} })
    const events = []
    const sdp = fixture.sdp.replace(/m=video \d+/, `m=video ${port}`)
    const analyzer = new BurstAnalyzer({
        burstId: 'analyzer-test',
        cameraId: 42,
        outputDir: dir,
        sdp,
        ffmpegPath,
        sendPacket: packet => new Promise((resolve, reject) => sender.send(packet, port, '127.0.0.1', error => error ? reject(error) : resolve())),
        minSeparationMs: 50,
        observationWindowMs: 600,
        hardSafetyTimeoutMs: 8000,
        emit: (stage, details) => events.push({ stage, details }),
        ...overrides
    })
    t.after(() => analyzer.dispose())
    return { analyzer, fixture, events, dir }
}

async function feedPaced(analyzer, units, { perUnitMs = 5 } = {}) {
    for (const unit of units) {
        analyzer.feed(unit.packets)
        await sleep(perUnitMs)
    }
}

test('live-fed units yield exactly three distinct JPEG frames and clean up temp files', { timeout: 20000 }, async t => {
    const { analyzer, fixture, dir } = await makeAnalyzer(t)
    await analyzer.start()
    const finishing = analyzer.finish()
    await feedPaced(analyzer, fixture.units)
    const result = await finishing

    assert.equal(result.frames.length, 3)
    for (const frame of result.frames) assert.equal(frame.subarray(0, 2).toString('hex'), 'ffd8', 'frame must be a JPEG')
    assert.equal(new Set(result.frameHashes).size, 3)
    assert.ok(result.candidateFramesEvaluated >= 3)
    assert.ok(result.framePtsTime[0] <= result.framePtsTime[1] && result.framePtsTime[1] <= result.framePtsTime[2])
    assert.deepEqual((await readdir(join(dir, '42'))).filter(name => name.startsWith('.tmp-')), [])
    assert.equal((await readdir(join(dir, '42'))).filter(name => /^frame-[123]\.jpg$/.test(name)).length, 3)
})

test('units replayed in one fast burst before live units decode the same as paced feeding', { timeout: 20000 }, async t => {
    const { analyzer, fixture } = await makeAnalyzer(t)
    await analyzer.start()
    const finishing = analyzer.finish()
    // Pre-roll: the first second of the fixture is replayed as fast as the sender allows, in chunks.
    const preRoll = fixture.units.slice(0, 20)
    for (let i = 0; i < preRoll.length; i += 4) {
        for (const unit of preRoll.slice(i, i + 4)) analyzer.feed(unit.packets)
        await sleep(2)
    }
    await feedPaced(analyzer, fixture.units.slice(20))
    const result = await finishing
    assert.equal(result.frames.length, 3)
    assert.equal(result.candidateEvaluations.filter(entry => entry.rejected).length, 0)
    // The earliest selected frame is a pre-roll frame, i.e. from the replayed part.
    assert.ok(result.framePtsTime[0] < 1.0)
})

test('a source that ends before any frame fails with selector diagnostics and removes temp files', { timeout: 20000 }, async t => {
    const { analyzer, dir } = await makeAnalyzer(t)
    await analyzer.start()
    const finishing = analyzer.finish()
    analyzer.stop('ring-call-ended')
    await assert.rejects(finishing, error => {
        assert.ok(error.kiBurstDiagnostics, 'failure must carry diagnostics')
        assert.equal(error.kiBurstDiagnostics.stopReason, 'ring-call-ended')
        return true
    })
    assert.deepEqual((await readdir(join(dir, '42'))).filter(name => name.startsWith('.tmp-')), [])
})

test('a failing packet sender stops the analysis and surfaces the send error', { timeout: 20000 }, async t => {
    const failure = new Error('socket closed')
    const { analyzer } = await makeAnalyzer(t, { sendPacket: async () => { throw failure } })
    const { fixture } = { fixture: await collectRtpFixture(await mkdtemp(join(tmpdir(), 'burst-analyzer-fx-'))) }
    await analyzer.start()
    const finishing = analyzer.finish()
    analyzer.feed(fixture.units[0].packets)
    await assert.rejects(finishing, /socket closed/)
    assert.equal(analyzer.stopReason, 'rtp-forward-error')
})

test('units fed after stop are ignored', { timeout: 20000 }, async t => {
    const { analyzer, fixture } = await makeAnalyzer(t, { sendPacket: async () => { throw new Error('must not send') } })
    await analyzer.start()
    const finishing = analyzer.finish().catch(error => error)
    analyzer.stop('ring-call-ended')
    analyzer.feed(fixture.units[0].packets)
    const outcome = await finishing
    assert.notEqual(outcome.message, 'must not send')
})

test('the hard safety timeout ends a source that never produces a frame', { timeout: 20000 }, async t => {
    const { analyzer } = await makeAnalyzer(t, { hardSafetyTimeoutMs: 400 })
    await analyzer.start()
    await assert.rejects(analyzer.finish(), error => {
        assert.equal(error.kiBurstDiagnostics.stopReason, 'hard-safety-timeout')
        return true
    })
})

test('the analyzer only supports the fixed three-frame burst', () => {
    assert.throws(() => new BurstAnalyzer({ burstId: 'x', frameCount: 4 }), /exactly 3 frames/)
})
