import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { firstValueFrom } from 'rxjs'
import { take } from 'rxjs/operators'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { StreamingSession } from './streaming-session.js'
import { H264RtpFrameGate } from './h264-rtp-frame-gate.js'
import {
    AdaptiveFrameSelector,
    DEFAULT_ANALYSIS_HEIGHT,
    DEFAULT_ANALYSIS_WIDTH,
    DEFAULT_CHANGED_BLOCK_THRESHOLD,
    DEFAULT_MIN_SELECTION_SEPARATION_MS
} from './adaptive-frame-selector.js'

function getVideoOnlySdp(sdp, videoPort) {
    const videoSection = sdp
        .split('\nm=')
        .slice(1)
        .map(section => `m=${section}`)
        .find(section => section.startsWith('m=video '))

    if (!videoSection) throw new Error('Ring WebRTC answer did not contain a video section')
    return videoSection.replace(/m=video \d+/, `m=video ${videoPort}`)
}

export function buildBurstFfmpegArgs({
    analysisWidth = DEFAULT_ANALYSIS_WIDTH,
    analysisHeight = DEFAULT_ANALYSIS_HEIGHT,
    candidatePattern
}) {
    return [
        '-hide_banner',
        '-loglevel', 'info',
        '-fflags', '+discardcorrupt',
        '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
        '-f', 'sdp',
        '-i', 'pipe:0',
        '-an',
        '-filter_complex', `[0:v]setpts=PTS-STARTPTS,showinfo,split=2[full][analysis];[analysis]scale=${analysisWidth}:${analysisHeight}:flags=fast_bilinear,format=gray[luma]`,
        '-map', '[luma]',
        '-pix_fmt', 'gray',
        '-fps_mode', 'passthrough',
        '-f', 'rawvideo',
        'pipe:1',
        '-map', '[full]',
        '-q:v', '2',
        '-fps_mode', 'passthrough',
        '-f', 'image2',
        '-y',
        candidatePattern
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

function candidateFilename(index) {
    return `candidate-${String(index + 1).padStart(6, '0')}.jpg`
}

export class Build12StreamingSession extends StreamingSession {
    async captureJpegBurst({
        burstId,
        frameCount = 3,
        timeoutMs = 8000,
        outputDir = '/data/ki-burst',
        minSeparationMs = DEFAULT_MIN_SELECTION_SEPARATION_MS,
        selectionThreshold = DEFAULT_CHANGED_BLOCK_THRESHOLD
    }) {
        if (frameCount !== 3) throw new Error('KI Burst is fixed to exactly 3 frames')
        if (this.hasEnded) throw new Error('Cannot capture KI Burst from an ended session')

        const deadline = Date.now() + timeoutMs
        let answerTimeout
        const ringSdp = await Promise.race([
            firstValueFrom(this.connection.onCallAnswered),
            firstValueFrom(this.onCallEnded),
            new Promise((_, reject) => {
                answerTimeout = setTimeout(() => reject(new Error(`KI Burst WebRTC answer timed out after ${timeoutMs} ms`)), timeoutMs)
            })
        ]).finally(() => clearTimeout(answerTimeout))
        if (!ringSdp) throw new Error('Ring call ended before KI Burst video became available')

        const videoPort = await this.reservePort(1)
        const cameraDir = join(outputDir, String(this.camera.id))
        const tempDir = join(cameraDir, `.tmp-${burstId}`)
        await mkdir(cameraDir, { recursive: true })
        await rm(tempDir, { recursive: true, force: true })
        await mkdir(tempDir, { recursive: true })

        const candidatePattern = join(tempDir, 'candidate-%06d.jpg')
        const args = buildBurstFfmpegArgs({ candidatePattern })
        const selector = new AdaptiveFrameSelector({ frameCount, minSeparationMs, changedBlockThreshold: selectionThreshold })
        const frameDiagnostics = new Map()
        const lumaFrames = new Map()
        const evaluated = new Set()
        const candidateEvaluations = []
        const gate = new H264RtpFrameGate({ requestKeyFrame: () => this.requestKeyFrame() })
        const lumaFrameBytes = DEFAULT_ANALYSIS_WIDTH * DEFAULT_ANALYSIS_HEIGHT

        let ffmpeg
        let timeout
        let hardKillTimeout
        let videoSubscription
        let rawBuffer = Buffer.alloc(0)
        let rawFrameIndex = 0
        let forwardQueue = Promise.resolve()
        let forwardError = null
        let stopRequested = false
        let stopReason = null
        let selectionResult = null

        const requestStop = reason => {
            if (stopRequested) return
            stopRequested = true
            stopReason = reason
            videoSubscription?.unsubscribe()
            if (ffmpeg && ffmpeg.exitCode === null) {
                ffmpeg.kill('SIGINT')
                hardKillTimeout = setTimeout(() => {
                    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
                }, 500)
            }
        }

        const tryEvaluate = index => {
            if (evaluated.has(index) || selectionResult) return
            const diagnostic = frameDiagnostics.get(index)
            const luma = lumaFrames.get(index)
            if (!diagnostic || !luma) return
            evaluated.add(index)

            const outcome = selector.evaluate({
                clean: true,
                luma,
                elapsedMs: Math.round(diagnostic.ptsTime * 1000),
                sourceIndex: index,
                pts: diagnostic.pts,
                ptsTime: diagnostic.ptsTime,
                observedAt: diagnostic.observedAt,
                pictType: diagnostic.pictType,
                rawChecksum: diagnostic.rawChecksum
            })
            candidateEvaluations.push({
                index,
                elapsedMs: Math.round(diagnostic.ptsTime * 1000),
                selected: outcome.selected,
                reason: outcome.reason,
                differenceScore: outcome.differenceScore ?? 0,
                changedBlockRatio: outcome.changedBlockRatio ?? 0
            })

            if (selector.complete) {
                selectionResult = selector.result()
                requestStop('adaptive-selection-complete')
            }
        }

        try {
            ffmpeg = spawn(pathToFfmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] })
            let stderr = ''
            let stderrLineBuffer = ''

            const parseStderrLine = line => {
                const diagnostic = parseShowinfoFrameLine(line)
                if (!diagnostic) return
                frameDiagnostics.set(diagnostic.index, diagnostic)
                tryEvaluate(diagnostic.index)
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

            ffmpeg.stdout.on('data', chunk => {
                rawBuffer = Buffer.concat([rawBuffer, chunk])
                while (rawBuffer.length >= lumaFrameBytes) {
                    const luma = Buffer.from(rawBuffer.subarray(0, lumaFrameBytes))
                    rawBuffer = rawBuffer.subarray(lumaFrameBytes)
                    const index = rawFrameIndex++
                    lumaFrames.set(index, luma)
                    tryEvaluate(index)
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
                            requestStop('rtp-forward-error')
                        })
                }
            })
            this.addSubscriptions(videoSubscription)

            this.onCallEnded.pipe(take(1)).subscribe(() => requestStop('ring-call-ended'))

            const exitPromise = new Promise((resolve, reject) => {
                ffmpeg.once('error', reject)
                ffmpeg.once('close', code => {
                    if (stderrLineBuffer) parseStderrLine(stderrLineBuffer)
                    if (forwardError) reject(forwardError)
                    else if (code === 0 || stopRequested) resolve()
                    else reject(new Error(`KI Burst ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
                })
            })

            ffmpeg.stdin.end(getVideoOnlySdp(ringSdp, videoPort))

            // Keep build-14 integrity semantics: only complete access units accepted by
            // H264RtpFrameGate can reach this decoder, and a fresh keyframe is requested.
            this.requestKeyFrame()

            const remainingMs = Math.max(1, deadline - Date.now())
            timeout = setTimeout(() => requestStop('timeout'), remainingMs)
            await exitPromise
            await forwardQueue
            if (forwardError) throw forwardError

            if (!selectionResult) selectionResult = selector.finalizeFallback()
            const { selected, diagnostics: selectionDiagnostics } = selectionResult
            if (selected.length !== frameCount) throw new Error(`KI Burst adaptive selector returned ${selected.length} frames`)

            const frames = []
            const paths = []
            for (let i = 0; i < selected.length; i++) {
                const source = selected[i]
                const tempPath = join(tempDir, candidateFilename(source.sourceIndex))
                const finalPath = join(cameraDir, `frame-${i + 1}.jpg`)
                const frame = await readFile(tempPath)
                if (!frame.length) throw new Error(`KI Burst selected frame ${i + 1} is empty`)
                frames.push(frame)
                paths.push(finalPath)
                await rename(tempPath, finalPath)
            }

            const frameHashes = frames.map(sha256)
            return {
                frames,
                paths,
                capturedAt: new Date().toISOString(),
                minimumSelectionSeparationMs: minSeparationMs,
                selectionMode: selectionDiagnostics.selectionMode,
                candidateFramesEvaluated: selectionDiagnostics.candidateFramesEvaluated,
                frameOffsetsMs: selectionDiagnostics.actualFrameOffsetsMs,
                actualFrameOffsetsMs: selectionDiagnostics.actualFrameOffsetsMs,
                differenceScores: selectionDiagnostics.differenceScores,
                changedBlockRatios: selectionDiagnostics.changedBlockRatios,
                selectionReasons: selectionDiagnostics.selectionReasons,
                selectionThreshold: selectionDiagnostics.selectionThreshold,
                framePts: selected.map(frame => frame.pts),
                framePtsTime: selected.map(frame => frame.ptsTime),
                frameTimestamps: selected.map(frame => frame.observedAt),
                frameTypes: selected.map(frame => frame.pictType),
                frameRawChecksums: selected.map(frame => frame.rawChecksum),
                frameHashes,
                rtpIntegrity: gate.snapshotStats(),
                candidateEvaluations,
                stopReason
            }
        } finally {
            if (timeout) clearTimeout(timeout)
            if (hardKillTimeout) clearTimeout(hardKillTimeout)
            videoSubscription?.unsubscribe()
            gate.stop()
            if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
            await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
    }
}
