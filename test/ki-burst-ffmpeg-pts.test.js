import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { buildBurstFfmpegArgs } from '../lib/streaming/build12-streaming-session.js'

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(pathToFfmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stdout.resume()
        child.stderr.on('data', chunk => { stderr += chunk.toString() })
        child.once('error', reject)
        child.once('close', code => resolve({ code, stderr }))
    })
}

test('adaptive ffmpeg drops Ring-style backwards pre-roll PTS before MJPEG encoding', { timeout: 10000 }, async t => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-ki-burst-pts-'))
    t.after(() => rm(outputDir, { recursive: true, force: true }))

    const candidatePattern = join(outputDir, 'candidate-%06d.jpg')
    const burstArgs = buildBurstFfmpegArgs({ candidatePattern })
    const filterIndex = burstArgs.indexOf('-filter_complex')
    const burstFilter = burstArgs[filterIndex + 1]
    const syntheticRingPts = "[0:v]setpts='if(eq(N,0),2.3/TB,(N-1)*0.05/TB)'[ring];"
    const filter = syntheticRingPts + burstFilter.replace('[0:v]', '[ring]')
    const outputArgs = burstArgs.slice(filterIndex + 2)

    const { code, stderr } = await runFfmpeg([
        '-hide_banner',
        '-loglevel', 'info',
        '-f', 'lavfi',
        '-i', 'testsrc2=size=320x180:rate=20:duration=4',
        '-filter_complex', filter,
        ...outputArgs
    ])

    assert.equal(code, 0, stderr)
    assert.doesNotMatch(stderr, /Invalid pts .* <= last/)

    const candidates = (await readdir(outputDir))
        .filter(name => name.startsWith('candidate-') && name.endsWith('.jpg'))
        .sort()
    assert.ok(candidates.length >= 3)
    assert.deepEqual(
        candidates,
        candidates.map((_, index) => `candidate-${String(index).padStart(6, '0')}.jpg`)
    )
})

test('burst ffmpeg input is probed with small limits so the first frame is not delayed by stream analysis', () => {
    const args = buildBurstFfmpegArgs({ candidatePattern: '/tmp/candidate-%06d.jpg' })
    const inputIndex = args.indexOf('-i')
    const probesize = args.indexOf('-probesize')
    const analyze = args.indexOf('-analyzeduration')
    assert.ok(probesize >= 0 && probesize < inputIndex)
    assert.ok(analyze >= 0 && analyze < inputIndex)
    assert.equal(args[probesize + 1], '32768')
    assert.equal(args[analyze + 1], '0')
})

test('real ffmpeg accepts the burst input options and decodes an SDP/RTP stream quickly', { timeout: 20000 }, async t => {
    // End-to-end: a real H.264 RTP stream is fed to ffmpeg exactly like the burst session does
    // (SDP on stdin, -probesize/-analyzeduration from buildBurstFfmpegArgs).
    const args = buildBurstFfmpegArgs({ candidatePattern: '/tmp/unused-%06d.jpg' })
    const options = args.slice(args.indexOf('-probesize'), args.indexOf('-protocol_whitelist'))
    assert.deepEqual(options, ['-probesize', '32768', '-analyzeduration', '0'])

    const port = 20000 + Math.floor(Math.random() * 20000)
    const sdp = `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=t\nc=IN IP4 127.0.0.1\nt=0 0\nm=video ${port} RTP/AVP 96\na=rtpmap:96 H264/90000\na=fmtp:96 packetization-mode=1\n`
    const receiver = spawn(pathToFfmpeg, [
        '-hide_banner', '-loglevel', 'info', ...options,
        '-protocol_whitelist', 'pipe,udp,rtp,file,crypto', '-f', 'sdp', '-i', 'pipe:0',
        '-an', '-vf', 'showinfo', '-fps_mode', 'passthrough', '-frames:v', '3', '-f', 'null', '-'
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    t.after(() => receiver.kill('SIGKILL'))
    receiver.stdin.end(sdp)

    let stderr = ''
    const firstFrame = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no decoded frame within 6s\n${stderr}`)), 6000)
        receiver.stderr.on('data', chunk => {
            stderr += chunk.toString()
            if (stderr.includes('showinfo')) { clearTimeout(timer); resolve() }
        })
    })

    await new Promise(resolve => setTimeout(resolve, 500))
    const sender = spawn(pathToFfmpeg, [
        '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20',
        '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '40',
        '-f', 'rtp', `rtp://127.0.0.1:${port}`
    ], { stdio: 'ignore' })
    t.after(() => sender.kill('SIGKILL'))

    const startedAt = Date.now()
    await firstFrame
    assert.ok(Date.now() - startedAt < 800, `first frame took ${Date.now() - startedAt} ms`)
})
