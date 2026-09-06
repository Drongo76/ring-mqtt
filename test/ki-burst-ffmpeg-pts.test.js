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
