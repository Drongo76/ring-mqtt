import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import dgram from 'node:dgram'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { H264RtpFrameGate } from '../../lib/streaming/h264-rtp-frame-gate.js'

// The ffmpeg that production uses (ffmpeg-for-homebridge) when installed, else the system ffmpeg.
async function resolveFfmpegPath() {
    try {
        return (await import('ffmpeg-for-homebridge')).default
    } catch {
        return execSync('command -v ffmpeg').toString().trim()
    }
}

export const ffmpegPath = await resolveFfmpegPath()
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function freeUdpPort() {
    const socket = dgram.createSocket('udp4')
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    const { port } = socket.address()
    await new Promise(resolve => socket.close(resolve))
    return port
}

// Real H.264 over RTP from ffmpeg (moving test pattern, keyframe every 10 frames).
export async function collectRtpFixture(dir, { seconds = 3 } = {}) {
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

