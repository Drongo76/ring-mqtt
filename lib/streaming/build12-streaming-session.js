import { spawn } from 'child_process'
import { mkdir, readFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { firstValueFrom } from 'rxjs'
import { concatMap, take } from 'rxjs/operators'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { StreamingSession } from './streaming-session.js'

function getVideoOnlySdp(sdp, videoPort) {
    const videoSection = sdp
        .split('\nm=')
        .slice(1)
        .map(section => `m=${section}`)
        .find(section => section.startsWith('m=video '))

    if (!videoSection) throw new Error('Ring WebRTC answer did not contain a video section')
    return videoSection.replace(/m=video \d+/, `m=video ${videoPort}`)
}

export function buildBurstFfmpegArgs({ intervalMs = 800, frameCount = 3, outputPattern }) {
    const fps = (1000 / intervalMs).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
    return [
        '-hide_banner',
        '-loglevel', 'error',
        '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
        '-f', 'sdp',
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-an',
        '-vf', `setpts=PTS-STARTPTS,fps=${fps}`,
        '-frames:v', String(frameCount),
        '-q:v', '2',
        '-f', 'image2',
        '-y',
        outputPattern
    ]
}

export class Build12StreamingSession extends StreamingSession {
    async captureJpegBurst({ burstId, frameCount = 3, intervalMs = 800, timeoutMs = 8000, outputDir = '/data/ki-burst' }) {
        if (frameCount !== 3) throw new Error('KI Burst is fixed to exactly 3 frames')
        if (this.hasEnded) throw new Error('Cannot capture KI Burst from an ended session')

        const videoPort = await this.reservePort(1)
        const ringSdp = await Promise.race([
            firstValueFrom(this.connection.onCallAnswered),
            firstValueFrom(this.onCallEnded)
        ])
        if (!ringSdp) throw new Error('Ring call ended before KI Burst video became available')

        const cameraDir = join(outputDir, String(this.camera.id))
        const tempDir = join(cameraDir, `.tmp-${burstId}`)
        await mkdir(cameraDir, { recursive: true })
        await rm(tempDir, { recursive: true, force: true })
        await mkdir(tempDir, { recursive: true })

        const outputPattern = join(tempDir, 'frame-%d.jpg')
        const args = buildBurstFfmpegArgs({ intervalMs, frameCount, outputPattern })
        let ffmpeg
        let timeout

        try {
            ffmpeg = spawn(pathToFfmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
            let stderr = ''
            ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString() })

            this.addSubscriptions(this.onVideoRtp.pipe(concatMap(rtp => {
                return this.videoSplitter.send(rtp.serialize(), { port: videoPort })
            })).subscribe())

            this.onCallEnded.pipe(take(1)).subscribe(() => {
                if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM')
            })

            const exitPromise = new Promise((resolve, reject) => {
                ffmpeg.once('error', reject)
                ffmpeg.once('close', code => {
                    if (code === 0) resolve()
                    else reject(new Error(`KI Burst ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
                })
            })

            ffmpeg.stdin.end(getVideoOnlySdp(ringSdp, videoPort))
            this.requestKeyFrame()

            const timeoutPromise = new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
                    reject(new Error(`KI Burst ffmpeg timed out after ${timeoutMs} ms`))
                }, timeoutMs)
            })

            await Promise.race([exitPromise, timeoutPromise])
            if (timeout) clearTimeout(timeout)

            const frames = []
            const tempPaths = []
            const paths = []
            for (let i = 1; i <= frameCount; i++) {
                const tempPath = join(tempDir, `frame-${i}.jpg`)
                const finalPath = join(cameraDir, `frame-${i}.jpg`)
                const frame = await readFile(tempPath)
                if (!frame.length) throw new Error(`KI Burst frame ${i} is empty`)
                frames.push(frame)
                tempPaths.push(tempPath)
                paths.push(finalPath)
            }
            // Only replace the published/latest burst after all three files are valid.
            for (let i = 0; i < frameCount; i++) {
                await rename(tempPaths[i], paths[i])
            }

            return {
                frames,
                paths,
                capturedAt: new Date().toISOString(),
                intervalMs,
                frameOffsetsMs: [0, intervalMs, intervalMs * 2]
            }
        } finally {
            if (timeout) clearTimeout(timeout)
            if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
            await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
    }
}
