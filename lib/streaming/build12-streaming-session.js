import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { firstValueFrom } from 'rxjs'
import { take } from 'rxjs/operators'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { StreamingSession } from './streaming-session.js'
import { H264RtpFrameGate } from './h264-rtp-frame-gate.js'

function getVideoOnlySdp(sdp, videoPort) {
    const videoSection = sdp
        .split('\nm=')
        .slice(1)
        .map(section => `m=${section}`)
        .find(section => section.startsWith('m=video '))

    if (!videoSection) throw new Error('Ring WebRTC answer did not contain a video section')
    return videoSection.replace(/m=video \d+/, `m=video ${videoPort}`)
}

function intervalSeconds(intervalMs) {
    return (intervalMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

export function buildBurstFfmpegArgs({ intervalMs = 800, frameCount = 3, outputPattern }) {
    const interval = intervalSeconds(intervalMs)
    return [
        '-hide_banner',
        '-loglevel', 'info',
        '-fflags', '+discardcorrupt',
        '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
        '-f', 'sdp',
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-an',
        '-vf', `setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${interval})',showinfo`,
        '-frames:v', String(frameCount),
        '-fps_mode', 'vfr',
        '-q:v', '2',
        '-f', 'image2',
        '-y',
        outputPattern
    ]
}

export function parseShowinfoFrameLine(line, observedAt = new Date().toISOString()) {
    if (!line.includes('showinfo')) return null
    const match = line.match(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:([^\s]+)/)
    if (!match) return null

    const index = Number(match[1])
    const pts = Number(match[2])
    const ptsTime = Number(match[3])
    if (!Number.isInteger(index) || !Number.isFinite(pts) || !Number.isFinite(ptsTime)) return null

    return {
        index,
        pts,
        ptsTime,
        observedAt,
        pictType: line.match(/\btype:([^\s]+)/)?.[1] || null,
        rawChecksum: line.match(/\bchecksum:([0-9A-Fa-f]+)/)?.[1] || null
    }
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex')
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
        let videoSubscription
        let forwardQueue = Promise.resolve()
        let forwardError = null
        const frameDiagnostics = new Map()
        const gate = new H264RtpFrameGate({ requestKeyFrame: () => this.requestKeyFrame() })

        try {
            ffmpeg = spawn(pathToFfmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
            let stderr = ''
            let stderrLineBuffer = ''

            const parseStderrLine = line => {
                const diagnostic = parseShowinfoFrameLine(line)
                if (diagnostic && diagnostic.index < frameCount) frameDiagnostics.set(diagnostic.index, diagnostic)
            }

            ffmpeg.stderr.on('data', chunk => {
                const text = chunk.toString()
                stderr = (stderr + text).slice(-32768)
                stderrLineBuffer += text
                let newlineIndex
                while ((newlineIndex = stderrLineBuffer.indexOf('\n')) >= 0) {
                    parseStderrLine(stderrLineBuffer.slice(0, newlineIndex))
                    stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1)
                }
            })

            videoSubscription = this.onVideoRtp.subscribe(rtp => {
                const result = gate.push(rtp.serialize())
                if (!result?.accepted) return

                for (const packet of result.packets) {
                    forwardQueue = forwardQueue
                        .then(() => this.videoSplitter.send(packet, { port: videoPort }))
                        .catch(error => {
                            forwardError ||= error
                            if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM')
                        })
                }
            })
            this.addSubscriptions(videoSubscription)

            this.onCallEnded.pipe(take(1)).subscribe(() => {
                if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM')
            })

            const exitPromise = new Promise((resolve, reject) => {
                ffmpeg.once('error', reject)
                ffmpeg.once('close', code => {
                    if (stderrLineBuffer) parseStderrLine(stderrLineBuffer)
                    if (forwardError) reject(forwardError)
                    else if (code === 0) resolve()
                    else reject(new Error(`KI Burst ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
                })
            })

            ffmpeg.stdin.end(getVideoOnlySdp(ringSdp, videoPort))

            // Do not start the sampling clock from WebRTC/session startup. The RTP gate
            // drops all pre-IDR video and requests a fresh keyframe; ffmpeg therefore sees
            // the first complete decodable IDR access unit as its first video frame.
            this.requestKeyFrame()

            const timeoutPromise = new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
                    reject(new Error(`KI Burst ffmpeg timed out after ${timeoutMs} ms`))
                }, timeoutMs)
            })

            await Promise.race([exitPromise, timeoutPromise])
            if (timeout) clearTimeout(timeout)
            await forwardQueue
            if (forwardError) throw forwardError

            const diagnostics = Array.from({ length: frameCount }, (_, index) => frameDiagnostics.get(index))
            if (diagnostics.some(value => !value)) {
                throw new Error(`KI Burst expected ${frameCount} decoded frame diagnostics, received ${diagnostics.filter(Boolean).length}`)
            }
            for (let i = 1; i < diagnostics.length; i++) {
                if (diagnostics[i].pts <= diagnostics[i - 1].pts) {
                    throw new Error(`KI Burst decoder returned duplicate/non-increasing PTS at frame ${i + 1}`)
                }
            }

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

            const firstPtsTime = diagnostics[0].ptsTime
            const frameOffsetsMs = diagnostics.map(frame => Math.round((frame.ptsTime - firstPtsTime) * 1000))
            const frameHashes = frames.map(sha256)
            const minimumSecondOffset = intervalMs - 5
            const minimumThirdOffset = (intervalMs * 2) - 10
            if (frameOffsetsMs[1] < minimumSecondOffset || frameOffsetsMs[2] < minimumThirdOffset) {
                throw new Error(`KI Burst selected frames too close together: ${frameOffsetsMs.join('/')}`)
            }

            // Only replace the published/latest burst after all three files and their
            // decoder diagnostics are valid.
            for (let i = 0; i < frameCount; i++) {
                await rename(tempPaths[i], paths[i])
            }

            return {
                frames,
                paths,
                capturedAt: new Date().toISOString(),
                intervalMs,
                targetFrameOffsetsMs: [0, intervalMs, intervalMs * 2],
                frameOffsetsMs,
                framePts: diagnostics.map(frame => frame.pts),
                framePtsTime: diagnostics.map(frame => frame.ptsTime),
                frameTimestamps: diagnostics.map(frame => frame.observedAt),
                frameTypes: diagnostics.map(frame => frame.pictType),
                frameRawChecksums: diagnostics.map(frame => frame.rawChecksum),
                frameHashes,
                rtpIntegrity: gate.snapshotStats()
            }
        } finally {
            if (timeout) clearTimeout(timeout)
            videoSubscription?.unsubscribe()
            gate.stop()
            if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
            await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
    }
}
