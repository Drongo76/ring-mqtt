import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { parentPort } from 'worker_threads'
import { firstValueFrom } from 'rxjs'
import { take } from 'rxjs/operators'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { StreamingSession } from './streaming-session.js'
import { H264RtpFrameGate, parseRtpPacket } from './h264-rtp-frame-gate.js'
import {
    AdaptiveFrameSelector,
    DEFAULT_ANALYSIS_HEIGHT,
    DEFAULT_ANALYSIS_WIDTH,
    DEFAULT_CHANGED_BLOCK_THRESHOLD,
    DEFAULT_MIN_SELECTION_SEPARATION_MS,
    DEFAULT_OBSERVATION_WINDOW_MS
} from './adaptive-frame-selector.js'

export const DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS = 12500
export const DEFAULT_KI_BURST_CANDIDATE_INTERVAL_MS = 50

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

function emitBurstDiagnostic(burstId, stage, details = {}) {
    if (!parentPort) return
    try {
        const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''
        parentPort.postMessage({ type: 'log_info', data: `KI Burst ${burstId} DIAG ${stage}${suffix}` })
    } catch {
        // Diagnostics must never alter KI Burst runtime behavior.
    }
}

export function candidateFilenameForSourceIndex(index) {
    if (!Number.isInteger(index) || index < 0) throw new TypeError('KI Burst candidate source index must be a non-negative integer')
    return `candidate-${String(index).padStart(6, '0')}.jpg`
}

export function buildBurstFfmpegArgs({
    analysisWidth = DEFAULT_ANALYSIS_WIDTH,
    analysisHeight = DEFAULT_ANALYSIS_HEIGHT,
    candidateIntervalMs = DEFAULT_KI_BURST_CANDIDATE_INTERVAL_MS,
    candidatePattern
}) {
    const candidateInterval = intervalSeconds(candidateIntervalMs)
    return [
        '-hide_banner',
        '-loglevel', 'info',
        '-fflags', '+discardcorrupt',
        '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
        '-f', 'sdp',
        '-i', 'pipe:0',
        '-an',
        // Three showinfo checkpoints prove identity across the decoded frame, the
        // full-resolution JPEG branch, and the reduced luma analysis branch.
        // Ring can emit older pre-roll P-frames immediately after the first clean IDR.
        // Restore the build-14 select stage before fan-out so those backwards PTS
        // never reach the passthrough MJPEG encoder and every downstream index stays
        // aligned across decoded diagnostics, full JPEGs and luma frames.
        '-filter_complex', `[0:v]setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${candidateInterval})',showinfo@decoded,split=2[full0][analysis0];[full0]showinfo@full[full];[analysis0]scale=${analysisWidth}:${analysisHeight}:flags=fast_bilinear,format=gray,showinfo@luma[luma]`,
        '-map', '[luma]',
        '-pix_fmt', 'gray',
        '-fps_mode', 'passthrough',
        '-f', 'rawvideo',
        'pipe:1',
        '-map', '[full]',
        '-q:v', '2',
        '-fps_mode', 'passthrough',
        '-start_number', '0',
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

    const stage = line.match(/showinfo@(decoded|full|luma)/)?.[1] || 'decoded'
    return {
        stage,
        index,
        pts,
        ptsTime,
        observedAt,
        pictType: line.match(/\btype:([^\s]+)/)?.[1] || null,
        rawChecksum: line.match(/\bchecksum:([0-9A-Fa-f]+)/)?.[1] || null
    }
}

export function evaluateCandidatePts({ sourceIndex, previousPts = null, decoded, full, luma }) {
    const sameSourceIndex = decoded?.index === sourceIndex && full?.index === sourceIndex && luma?.index === sourceIndex
    const samePts = decoded?.pts === full?.pts && decoded?.pts === luma?.pts
    const samePtsTime = decoded?.ptsTime === full?.ptsTime && decoded?.ptsTime === luma?.ptsTime

    if (!sameSourceIndex || !samePts || !samePtsTime) {
        throw new Error(`KI Burst decoded/full/luma PTS mismatch at source index ${sourceIndex}`)
    }

    if (Number.isFinite(previousPts) && decoded.pts <= previousPts) {
        return {
            accepted: false,
            rejection: {
                sourceIndex,
                previousPts,
                currentPts: decoded.pts,
                decodedPts: decoded.pts,
                fullPts: full.pts,
                lumaPts: luma.pts,
                rejectionReason: decoded.pts === previousPts ? 'duplicate_pts' : 'non_increasing_pts'
            }
        }
    }

    return { accepted: true, pts: decoded.pts }
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

        const diagnosticStages = new Set()
        const emitOnce = (stage, details = {}) => {
            if (diagnosticStages.has(stage)) return
            diagnosticStages.add(stage)
            emitBurstDiagnostic(burstId, stage, details)
        }

        const videoPort = await this.reservePort(1)
        emitOnce('video_port_reserved', { videoPort })
        const burstStartedAtMs = Date.now()
        const hardDeadline = burstStartedAtMs + hardSafetyTimeoutMs
        let answerTimeout
        const answerRemainingMs = Math.max(1, hardDeadline - Date.now())
        emitOnce('waiting_for_sdp_answer', { answerRemainingMs })
        const ringSdp = await Promise.race([
            firstValueFrom(this.connection.onCallAnswered),
            firstValueFrom(this.onCallEnded),
            new Promise((_, reject) => {
                answerTimeout = setTimeout(() => {
                    emitOnce('sdp_answer_timeout', { hardSafetyTimeoutMs })
                    reject(new Error(`KI Burst WebRTC answer exceeded hard safety timeout ${hardSafetyTimeoutMs} ms`))
                }, answerRemainingMs)
            })
        ]).finally(() => clearTimeout(answerTimeout))
        if (!ringSdp) throw new Error('Ring call ended before KI Burst video became available')
        emitOnce('sdp_answer_received', { sdpLength: ringSdp.length })

        const cameraDir = join(outputDir, String(this.camera.id))
        const tempDir = join(cameraDir, `.tmp-${burstId}`)
        await mkdir(cameraDir, { recursive: true })
        await rm(tempDir, { recursive: true, force: true })
        await mkdir(tempDir, { recursive: true })

        const candidatePattern = join(tempDir, 'candidate-%06d.jpg')
        const args = buildBurstFfmpegArgs({ candidatePattern })
        const selector = new AdaptiveFrameSelector({
            frameCount,
            minSeparationMs,
            changedBlockThreshold: selectionThreshold,
            observationWindowMs
        })
        const decodedDiagnostics = new Map()
        const fullDiagnostics = new Map()
        const lumaDiagnostics = new Map()
        const lumaFrames = new Map()
        const candidateEvaluations = []
        const rejectedPtsCandidates = []
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
        let previousAcceptedPts = null
        let forwardQueue = Promise.resolve()
        let forwardError = null
        let processingError = null
        let stopRequested = false
        let stopReason = null
        let firstCleanWallClockMs = null

        const captureDiagnostics = () => ({
            selectionMode: 'adaptive_buffered',
            observationWindowMs,
            candidateFramesEvaluated: selector.candidateFramesEvaluated,
            rejectedPtsCandidates: rejectedPtsCandidates.map(entry => ({ ...entry })),
            firstCleanFrameAt: firstCleanWallClockMs ? new Date(firstCleanWallClockMs).toISOString() : null
        })

        const requestStop = reason => {
            if (stopRequested) return
            stopRequested = true
            stopReason = reason
            emitBurstDiagnostic(burstId, 'stop_requested', {
                reason,
                decoded: decodedDiagnostics.size,
                full: fullDiagnostics.size,
                lumaDiagnostics: lumaDiagnostics.size,
                rawLuma: lumaFrames.size,
                candidates: selector.candidateFramesEvaluated,
                rtpIntegrity: gate.snapshotStats()
            })
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
            emitOnce('observation_window_started', { observationWindowMs })
            const hardRemaining = Math.max(1, hardDeadline - firstCleanWallClockMs)
            observationTimeout = setTimeout(
                () => requestStop('observation-window-complete'),
                Math.min(observationWindowMs, hardRemaining)
            )
        }

        const evaluateReadyCandidates = () => {
            while (!processingError &&
                decodedDiagnostics.has(nextEvaluateIndex) &&
                fullDiagnostics.has(nextEvaluateIndex) &&
                lumaDiagnostics.has(nextEvaluateIndex) &&
                lumaFrames.has(nextEvaluateIndex)) {
                const index = nextEvaluateIndex++
                const decoded = decodedDiagnostics.get(index)
                const full = fullDiagnostics.get(index)
                const lumaDiagnostic = lumaDiagnostics.get(index)
                const luma = lumaFrames.get(index)

                let ptsDecision
                try {
                    ptsDecision = evaluateCandidatePts({
                        sourceIndex: index,
                        previousPts: previousAcceptedPts,
                        decoded,
                        full,
                        luma: lumaDiagnostic
                    })
                } catch (error) {
                    processingError = error
                    processingError.kiBurstDiagnostics = captureDiagnostics()
                    requestStop('frame-identity-error')
                    return
                }

                if (!ptsDecision.accepted) {
                    rejectedPtsCandidates.push(ptsDecision.rejection)
                    candidateEvaluations.push({
                        index,
                        pts: decoded.pts,
                        fullPts: full.pts,
                        lumaPts: lumaDiagnostic.pts,
                        elapsedMs: Math.round(decoded.ptsTime * 1000),
                        selectedImmediately: false,
                        reason: ptsDecision.rejection.rejectionReason,
                        rejected: true,
                        previousPts: ptsDecision.rejection.previousPts
                    })
                    continue
                }

                const outcome = selector.evaluate({
                    clean: true,
                    luma,
                    elapsedMs: Math.round(decoded.ptsTime * 1000),
                    sourceIndex: index,
                    pts: decoded.pts,
                    ptsTime: decoded.ptsTime,
                    observedAt: decoded.observedAt,
                    pictType: decoded.pictType,
                    rawChecksum: decoded.rawChecksum,
                    fullRawChecksum: full.rawChecksum,
                    lumaRawChecksum: lumaDiagnostic.rawChecksum
                })
                emitOnce('first_complete_candidate', {
                    sourceIndex: index,
                    pts: decoded.pts,
                    ptsTime: decoded.ptsTime,
                    pictType: decoded.pictType
                })
                previousAcceptedPts = decoded.pts
                candidateEvaluations.push({
                    index,
                    pts: decoded.pts,
                    fullPts: full.pts,
                    lumaPts: lumaDiagnostic.pts,
                    elapsedMs: Math.round(decoded.ptsTime * 1000),
                    selectedImmediately: outcome.selected,
                    reason: outcome.reason,
                    differenceScore: outcome.differenceScore ?? 0,
                    changedBlockRatio: outcome.changedBlockRatio ?? 0
                })

                if (selector.candidates.length === 1) startObservationWindow()
            }
        }

        try {
            ffmpeg = spawn(pathToFfmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] })
            emitOnce('ffmpeg_spawned', { pid: ffmpeg.pid ?? null })
            let stderr = ''
            let stderrLineBuffer = ''

            const parseStderrLine = line => {
                const diagnostic = parseShowinfoFrameLine(line)
                if (!diagnostic) return
                if (diagnostic.stage === 'full') {
                    fullDiagnostics.set(diagnostic.index, diagnostic)
                    emitOnce('first_full_frame', { index: diagnostic.index, pts: diagnostic.pts, ptsTime: diagnostic.ptsTime })
                } else if (diagnostic.stage === 'luma') {
                    lumaDiagnostics.set(diagnostic.index, diagnostic)
                    emitOnce('first_luma_diagnostic', { index: diagnostic.index, pts: diagnostic.pts, ptsTime: diagnostic.ptsTime })
                } else {
                    decodedDiagnostics.set(diagnostic.index, diagnostic)
                    emitOnce('first_decoded_frame', {
                        index: diagnostic.index,
                        pts: diagnostic.pts,
                        ptsTime: diagnostic.ptsTime,
                        pictType: diagnostic.pictType
                    })
                }
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
                    const index = rawFrameIndex++
                    lumaFrames.set(index, luma)
                    emitOnce('first_raw_luma_frame', { index, bytes: luma.length })
                    evaluateReadyCandidates()
                }
            })

            videoSubscription = this.onVideoRtp.subscribe(rtp => {
                const serialized = rtp.serialize()
                const parsed = parseRtpPacket(serialized)
                emitOnce('first_rtp_received', parsed ? {
                    sequenceNumber: parsed.sequenceNumber,
                    timestamp: parsed.timestamp,
                    marker: parsed.marker,
                    ssrc: parsed.ssrc
                } : { parseFailed: true, bytes: serialized.length })

                const result = gate.push(serialized)
                if (!result?.accepted) return
                const integrity = gate.snapshotStats()
                emitOnce('first_gate_accepted_au', {
                    packetCount: result.packets.length,
                    acceptedAccessUnits: integrity.acceptedAccessUnits,
                    firstForwardedRtpTimestamp: integrity.firstForwardedRtpTimestamp
                })

                for (const packet of result.packets) {
                    forwardQueue = forwardQueue
                        .then(async () => {
                            await this.videoSplitter.send(packet, { port: videoPort })
                            emitOnce('first_rtp_forwarded_udp', { videoPort })
                        })
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
            emitOnce('sdp_written_to_ffmpeg', { videoPort })

            // Keep build-14 integrity semantics unchanged: only complete access units
            // accepted by H264RtpFrameGate reach the decoder, and a fresh keyframe is requested.
            this.requestKeyFrame()
            emitOnce('keyframe_requested')

            const hardRemainingMs = Math.max(1, hardDeadline - Date.now())
            hardSafetyTimeout = setTimeout(() => requestStop('hard-safety-timeout'), hardRemainingMs)

            await exitPromise
            await forwardQueue
            if (forwardError) throw forwardError
            if (processingError) throw processingError

            let selectionResult
            try {
                selectionResult = selector.finalizeBuffered()
            } catch (error) {
                error.kiBurstDiagnostics = captureDiagnostics()
                throw error
            }
            const { selected, diagnostics: selectionDiagnostics } = selectionResult
            if (selected.length !== frameCount) throw new Error(`KI Burst adaptive selector returned ${selected.length} frames`)

            const frames = []
            const paths = []
            for (let i = 0; i < selected.length; i++) {
                const source = selected[i]
                const decoded = decodedDiagnostics.get(source.sourceIndex)
                const full = fullDiagnostics.get(source.sourceIndex)
                const lumaDiagnostic = lumaDiagnostics.get(source.sourceIndex)
                const luma = lumaFrames.get(source.sourceIndex)
                if (!decoded || !full || !lumaDiagnostic || !luma ||
                    decoded.pts !== source.pts || full.pts !== source.pts || lumaDiagnostic.pts !== source.pts) {
                    throw new Error(`KI Burst selected JPEG/luma mapping mismatch for source index ${source.sourceIndex}`)
                }

                // Full JPEG sequence number is deliberately the same zero-based source index
                // as showinfo@full and the luma raw-frame index. PTS equality was checked above.
                const tempPath = join(tempDir, candidateFilenameForSourceIndex(source.sourceIndex))
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
                rejectedPtsCandidates,
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
