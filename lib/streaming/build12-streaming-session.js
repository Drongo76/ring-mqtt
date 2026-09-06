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
    DEFAULT_MIN_SELECTION_SEPARATION_MS,
    DEFAULT_OBSERVATION_WINDOW_MS
} from './adaptive-frame-selector.js'

export const DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS = 12500

function getVideoOnlySdp(sdp, videoPort) {
    const videoSection = sdp
        .split('\nm=')
        .slice(1)
        .map(section => `m=${section}`)
        .find(section => section.startsWith('m=video '))

    if (!videoSection) throw new Error('Ring WebRTC answer did not contain a video section')
    return videoSection.replace(/m=video \d+/, `m=video ${videoPort}`)
}

export function candidateFilenameForPts(pts) {
    if (!Number.isInteger(pts)) throw new TypeError('KI Burst candidate PTS must be an integer')
    return `candidate-${pts}.jpg`
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
        // showinfo is before split, so decoder index/PTS describes the exact frame sent
        // to both the full-resolution JPEG branch and the reduced luma analysis branch.
        '-filter_complex', `[0:v]setpts=PTS-STARTPTS,showinfo,split=2[full][analysis];[analysis]scale=${analysisWidth}:${analysisHeight}:flags=fast_bilinear,format=gray[luma]`,
        '-map', '[luma]',
        '-pix_fmt', 'gray',
        '-fps_mode', 'passthrough',
        '-f', 'rawvideo',
        'pipe:1',
        '-map', '[full]',
        '-q:v', '2',
        '-fps_mode', 'passthrough',
        // Key JPEG filenames by the same decoded PTS reported by showinfo. This makes
        // the selected full-resolution JPEG provably correspond to its analyzed luma frame.
        '-frame_pts', '1',
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

export class Build12StreamingSession extends StreamingSession {
    async captureJpegBurst({
        burstId,
        frameCount = 3,
        outputDir = '/data/ki-burst',
        minSeparationMs = DEFAULT_MIN_SELECTION_SEPARATION_MS,
        selectionThreshold = DEFAULT_CHANGED_BLOCK_THRESHOLD,
        observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS,
        hardSafetyTimeoutMs = DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS
    }) {
        if (frameCount !== 3) throw new Error('KI Burst is fixed to exactly 3 frames')
        if (this.hasEnded) throw new Error('Cannot capture KI Burst from an ended session')

        const burstStartedAtMs = Date.now()
        const hardDeadline = burstStartedAtMs + hardSafetyTimeoutMs
        let answerTimeout
        const answerRemainingMs = Math.max(1, hardDeadline - Date.now())
        const ringSdp = await Promise.race([
            firstValueFrom(this.connection.onCallAnswered),
            firstValueFrom(this.onCallEnded),
            new Promise((_, reject) => {
                answerTimeout = setTimeout(() => reject(new Error(`KI Burst WebRTC answer exceeded hard safety timeout ${hardSafetyTimeoutMs} ms`)), answerRemainingMs)
            })
        ]).finally(() => clearTimeout(answerTimeout))
        if (!ringSdp) throw new Error('Ring call ended before KI Burst video became available')

        const videoPort = await this.reservePort(1)
        const cameraDir = join(outputDir, String(this.camera.id))
        const tempDir = join(cameraDir, `.tmp-${burstId}`)
        await mkdir(cameraDir, { recursive: true })
        await rm(tempDir, { recursive: true, force: true })
        await mkdir(tempDir, { recursive: true })

        const candidatePattern = join(tempDir, 'candidate-%d.jpg')
        const args = buildBurstFfmpegArgs({ candidatePattern })
        const selector = new AdaptiveFrameSelector({
            frameCount,
            minSeparationMs,
            changedBlockThreshold: selectionThreshold,
            observationWindowMs
        })
        const frameDiagnostics = new Map()
        const lumaFrames = new Map()
        const candidateEvaluations = []
        const gate = new H264RtpFrameGate({ requestKeyFrame: () => this.requestKeyFrame() })
        const lumaFrameBytes = DEFAULT_ANALYSIS_WIDTH * DEFAULT_ANALYSIS_HEIGHT

        let ffmpeg
        let observationTimeout
        let hardSafetyTimeout
        let hardKillTimeout
        let videoSubscription
        let rawBuffer = Buffer.alloc(0)
        let rawFrameIndex = 0
        let nextEvaluateIndex = 0
        let forwardQueue = Promise.resolve()
        let forwardError = null
        let processingError = null
        let stopRequested = false
        let stopReason = null
        let firstCleanWallClockMs = null

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

        const startObservationWindow = () => {
            if (firstCleanWallClockMs !== null) return
            firstCleanWallClockMs = Date.now()
            const hardRemaining = Math.max(1, hardDeadline - firstCleanWallClockMs)
            observationTimeout = setTimeout(
                () => requestStop('observation-window-complete'),
                Math.min(observationWindowMs, hardRemaining)
            )
        }

        const evaluateReadyCandidates = () => {
            while (!processingError && frameDiagnostics.has(nextEvaluateIndex) && lumaFrames.has(nextEvaluateIndex)) {
                const index = nextEvaluateIndex++
                const diagnostic = frameDiagnostics.get(index)
                const luma = lumaFrames.get(index)
                const previous = selector.candidates.at(-1)
                if (previous && diagnostic.pts <= previous.pts) {
                    processingError = new Error(`KI Burst decoder returned duplicate/non-increasing PTS at candidate ${index + 1}`)
                    requestStop('decoder-pts-error')
                    return
                }

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
                    pts: diagnostic.pts,
                    elapsedMs: Math.round(diagnostic.ptsTime * 1000),
                    selectedImmediately: outcome.selected,
                    reason: outcome.reason,
                    differenceScore: outcome.differenceScore ?? 0,
                    changedBlockRatio: outcome.changedBlockRatio ?? 0
                })

                if (index === 0) startObservationWindow()
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
                evaluateReadyCandidates()
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
                    lumaFrames.set(rawFrameIndex++, luma)
                    evaluateReadyCandidates()
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
                    else if (processingError) reject(processingError)
                    else if (code === 0 || stopRequested) resolve()
                    else reject(new Error(`KI Burst ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
                })
            })

            ffmpeg.stdin.end(getVideoOnlySdp(ringSdp, videoPort))

            // Keep build-14 integrity semantics unchanged: only complete access units
            // accepted by H264RtpFrameGate reach the decoder, and a fresh keyframe is requested.
            this.requestKeyFrame()

            const hardRemainingMs = Math.max(1, hardDeadline - Date.now())
            hardSafetyTimeout = setTimeout(() => requestStop('hard-safety-timeout'), hardRemainingMs)

            await exitPromise
            await forwardQueue
            if (forwardError) throw forwardError
            if (processingError) throw processingError

            const selectionResult = selector.finalizeBuffered()
            const { selected, diagnostics: selectionDiagnostics } = selectionResult
            if (selected.length !== frameCount) throw new Error(`KI Burst adaptive selector returned ${selected.length} frames`)

            const frames = []
            const paths = []
            for (let i = 0; i < selected.length; i++) {
                const source = selected[i]
                const diagnostic = frameDiagnostics.get(source.sourceIndex)
                const luma = lumaFrames.get(source.sourceIndex)
                if (!diagnostic || !luma || diagnostic.pts !== source.pts || diagnostic.ptsTime !== source.ptsTime) {
                    throw new Error(`KI Burst selected JPEG/luma mapping mismatch for source index ${source.sourceIndex}`)
                }

                // image2 -frame_pts 1 names the full-resolution JPEG with this exact
                // showinfo PTS; sourceIndex identifies the matching luma frame from split.
                const tempPath = join(tempDir, candidateFilenameForPts(source.pts))
                const finalPath = join(cameraDir, `frame-${i + 1}.jpg`)
                const frame = await readFile(tempPath)
                if (!frame.length) throw new Error(`KI Burst selected frame ${i + 1} is empty`)
                frames.push(frame)
                paths.push(finalPath)
                await rename(tempPath, finalPath)
            }

            const frameHashes = frames.map(sha256)
            const totalBurstDurationMs = Date.now() - burstStartedAtMs
            return {
                frames,
                paths,
                capturedAt: new Date().toISOString(),
                selectionMode: selectionDiagnostics.selectionMode,
                observationWindowMs: selectionDiagnostics.observationWindowMs,
                candidateFramesEvaluated: selectionDiagnostics.candidateFramesEvaluated,
                frameOffsetsMs: selectionDiagnostics.actualFrameOffsetsMs,
                actualFrameOffsetsMs: selectionDiagnostics.actualFrameOffsetsMs,
                differenceScores: selectionDiagnostics.differenceScores,
                changedBlockRatios: selectionDiagnostics.changedBlockRatios,
                pairwiseDifferenceScores: selectionDiagnostics.pairwiseDifferenceScores,
                totalDiversityScore: selectionDiagnostics.totalDiversityScore,
                selectionReasons: selectionDiagnostics.selectionReasons,
                selectionThreshold: selectionDiagnostics.selectionThreshold,
                minimumSelectionSeparationMs: selectionDiagnostics.minimumSelectionSeparationMs,
                firstCleanFrameAt: firstCleanWallClockMs ? new Date(firstCleanWallClockMs).toISOString() : selectionDiagnostics.firstCleanFrameAt,
                totalBurstDurationMs,
                frameSourceIndices: selected.map(frame => frame.sourceIndex),
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
            if (observationTimeout) clearTimeout(observationTimeout)
            if (hardSafetyTimeout) clearTimeout(hardSafetyTimeout)
            if (hardKillTimeout) clearTimeout(hardKillTimeout)
            videoSubscription?.unsubscribe()
            gate.stop()
            if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL')
            await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
    }
}
