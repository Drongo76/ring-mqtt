import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, readFile, readdir, rename, rm } from 'fs/promises'
import { join } from 'path'
import {
    AdaptiveFrameSelector,
    DEFAULT_ANALYSIS_HEIGHT,
    DEFAULT_ANALYSIS_WIDTH,
    DEFAULT_CHANGED_BLOCK_THRESHOLD,
    DEFAULT_MIN_SELECTION_SEPARATION_MS,
    DEFAULT_OBSERVATION_WINDOW_MS
} from './adaptive-frame-selector.js'

export const DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS = 25000
export const DEFAULT_KI_BURST_CANDIDATE_INTERVAL_MS = 50

function intervalSeconds(intervalMs) {
    return (intervalMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

export function getObservationStopDelayMs(observationWindowMs) {
    return Math.max(1, observationWindowMs)
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

const CANDIDATE_JPEG_FILENAME = /^candidate-(\d{6})\.jpg$/

export function inspectCandidateJpegFiles(entries, metadataSourceIndices = []) {
    const physical = []
    for (const entry of entries || []) {
        const filename = typeof entry === 'string' ? entry : entry?.name
        const match = filename?.match(CANDIDATE_JPEG_FILENAME)
        if (!match) continue
        const sourceIndex = Number(match[1])
        if (!Number.isInteger(sourceIndex)) continue
        physical.push({ filename, sourceIndex })
    }
    physical.sort((a, b) => a.sourceIndex - b.sourceIndex || a.filename.localeCompare(b.filename))

    const existingSourceIndices = [...new Set(physical.map(entry => entry.sourceIndex))]
    const existing = new Set(existingSourceIndices)
    const normalizedMetadataSourceIndices = [...new Set(
        (metadataSourceIndices || []).filter(index => Number.isInteger(index) && index >= 0)
    )].sort((a, b) => a - b)
    const missingMetadataSourceIndices = normalizedMetadataSourceIndices.filter(index => !existing.has(index))

    return {
        files: physical.map(entry => entry.filename),
        jpegCount: physical.length,
        minSourceIndex: existingSourceIndices.length ? existingSourceIndices[0] : null,
        maxSourceIndex: existingSourceIndices.length ? existingSourceIndices.at(-1) : null,
        candidate000086Present: existing.has(86),
        existingSourceIndices,
        metadataSourceIndices: normalizedMetadataSourceIndices,
        missingMetadataSourceIndices
    }
}

export function restrictSelectorCandidatesToExistingJpegs(selector, existingSourceIndices) {
    if (!selector || !Array.isArray(selector.candidates)) throw new TypeError('KI Burst selector candidates are required')
    if (selector.finalized) throw new Error('KI Burst selector cannot be restricted after finalization')

    const existing = new Set(existingSourceIndices || [])
    const removedSourceIndices = selector.candidates
        .filter(candidate => !existing.has(candidate.sourceIndex))
        .map(candidate => candidate.sourceIndex)
    selector.candidates = selector.candidates.filter(candidate => existing.has(candidate.sourceIndex))
    selector.firstCleanFrameAt = selector.candidates[0]?.observedAt || null

    return {
        removedSourceIndices,
        eligibleSourceIndices: selector.candidates.map(candidate => candidate.sourceIndex)
    }
}

export async function loadSelectedCandidateJpegs(tempDir, selected) {
    const frames = []
    const sourceIndices = []
    for (const source of selected || []) {
        const sourceIndex = source?.sourceIndex
        const frame = await readFile(join(tempDir, candidateFilenameForSourceIndex(sourceIndex)))
        if (!frame.length) throw new Error(`KI Burst selected JPEG is empty for source index ${sourceIndex}`)
        frames.push(frame)
        sourceIndices.push(sourceIndex)
    }
    return {
        frames,
        sourceIndices,
        frameHashes: frames.map(sha256)
    }
}

// Decodes H.264 RTP with ffmpeg, scores every decoded candidate and selects the burst frames.
// It knows nothing about Ring, WebRTC or where the packets come from: the owner supplies the SDP
// that points at `sendPacket`, then calls feed() with complete access units (live or replayed
// from a buffer) and stop() when the source ends.
export class BurstAnalyzer {
    constructor({
        burstId,
        cameraId,
        outputDir = '/data/ki-burst',
        sdp,
        ffmpegPath,
        sendPacket,
        requestKeyFrame = () => {},
        getRtpIntegrity = () => ({}),
        frameCount = 3,
        minSeparationMs = DEFAULT_MIN_SELECTION_SEPARATION_MS,
        selectionThreshold = DEFAULT_CHANGED_BLOCK_THRESHOLD,
        observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS,
        hardSafetyTimeoutMs = DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS,
        emit = () => {},
        onStop = () => {}
    }) {
        if (frameCount !== 3) throw new Error('KI Burst is fixed to exactly 3 frames')
        this.burstId = burstId
        this.cameraId = cameraId
        this.outputDir = outputDir
        this.sdp = sdp
        this.ffmpegPath = ffmpegPath
        this.sendPacket = sendPacket
        this.requestKeyFrame = requestKeyFrame
        this.getRtpIntegrity = getRtpIntegrity
        this.frameCount = frameCount
        this.observationWindowMs = observationWindowMs
        this.hardSafetyTimeoutMs = hardSafetyTimeoutMs
        this.emit = emit
        this.onStop = onStop

        this.selector = new AdaptiveFrameSelector({
            frameCount,
            minSeparationMs,
            changedBlockThreshold: selectionThreshold,
            observationWindowMs
        })
        this.decodedDiagnostics = new Map()
        this.fullDiagnostics = new Map()
        this.lumaDiagnostics = new Map()
        this.lumaFrames = new Map()
        this.candidateEvaluations = []
        this.rejectedPtsCandidates = []

        this.stopRequested = false
        this.stopReason = null
        this.firstCleanWallClockMs = null
        this.candidateJpegInventory = null
        this.excludedMissingJpegSourceIndices = []
        this.selectedSourceIndices = []
        this.forwardQueue = Promise.resolve()
        this.forwardError = null
        this.processingError = null
        this.ffmpeg = null
        this.timers = { observation: null, hardSafety: null, hardKill: null }
        this.diagnosticStages = new Set()
    }

    emitOnce(stage, details = {}) {
        if (this.diagnosticStages.has(stage)) return
        this.diagnosticStages.add(stage)
        this.emit(stage, details)
    }

    captureDiagnostics() {
        return {
            selectionMode: 'adaptive_buffered',
            observationWindowMs: this.observationWindowMs,
            candidateFramesEvaluated: this.selector.candidateFramesEvaluated,
            candidateEvaluations: this.candidateEvaluations.map(entry => ({ ...entry })),
            rejectedPtsCandidates: this.rejectedPtsCandidates.map(entry => ({ ...entry })),
            firstCleanFrameAt: this.firstCleanWallClockMs ? new Date(this.firstCleanWallClockMs).toISOString() : null,
            candidateJpegInventory: this.candidateJpegInventory,
            excludedMissingJpegSourceIndices: [...this.excludedMissingJpegSourceIndices],
            selectedSourceIndices: [...this.selectedSourceIndices],
            stopReason: this.stopReason,
            rtpIntegrity: this.getRtpIntegrity()
        }
    }

    // Forwards the packets of one complete access unit to the decoder, in order.
    feed(packets) {
        if (this.stopRequested) return
        for (const packet of packets) {
            this.forwardQueue = this.forwardQueue
                .then(async () => {
                    await this.sendPacket(packet)
                    this.emitOnce('first_rtp_forwarded_udp')
                })
                .catch(error => {
                    this.forwardError ||= error
                    this.stop('rtp-forward-error')
                })
        }
    }

    // Resolves when every packet fed so far has been handed to the decoder.
    flush() {
        return this.forwardQueue
    }

    stop(reason) {
        if (this.stopRequested) return
        this.stopRequested = true
        this.stopReason = reason
        this.emit('stop_requested', {
            at: new Date().toISOString(),
            reason,
            decoded: this.decodedDiagnostics.size,
            full: this.fullDiagnostics.size,
            lumaDiagnostics: this.lumaDiagnostics.size,
            rawLuma: this.lumaFrames.size,
            candidates: this.selector.candidateFramesEvaluated,
            rtpIntegrity: this.getRtpIntegrity()
        })
        this.onStop()
        if (this.ffmpeg && this.ffmpeg.exitCode === null) {
            this.ffmpeg.kill('SIGINT')
            this.timers.hardKill = setTimeout(() => {
                if (this.ffmpeg && this.ffmpeg.exitCode === null) this.ffmpeg.kill('SIGKILL')
            }, 500)
        }
    }

    startObservationWindow() {
        if (this.firstCleanWallClockMs !== null) return
        this.firstCleanWallClockMs = Date.now()
        if (this.timers.hardSafety) {
            clearTimeout(this.timers.hardSafety)
            this.timers.hardSafety = null
        }
        this.emitOnce('observation_window_started', { at: new Date(this.firstCleanWallClockMs).toISOString(), observationWindowMs: this.observationWindowMs })
        this.timers.observation = setTimeout(() => {
            this.emit('observation_complete', {
                at: new Date().toISOString(),
                observationWindowMs: this.observationWindowMs,
                actualObservationMs: Date.now() - this.firstCleanWallClockMs
            })
            this.stop('observation-window-complete')
        }, getObservationStopDelayMs(this.observationWindowMs))
    }

    evaluateReadyCandidates() {
        while (!this.processingError &&
            this.decodedDiagnostics.has(this.nextEvaluateIndex) &&
            this.fullDiagnostics.has(this.nextEvaluateIndex) &&
            this.lumaDiagnostics.has(this.nextEvaluateIndex) &&
            this.lumaFrames.has(this.nextEvaluateIndex)) {
            const index = this.nextEvaluateIndex++
            const decoded = this.decodedDiagnostics.get(index)
            const full = this.fullDiagnostics.get(index)
            const lumaDiagnostic = this.lumaDiagnostics.get(index)
            const luma = this.lumaFrames.get(index)

            let ptsDecision
            try {
                ptsDecision = evaluateCandidatePts({
                    sourceIndex: index,
                    previousPts: this.previousAcceptedPts,
                    decoded,
                    full,
                    luma: lumaDiagnostic
                })
            } catch (error) {
                this.processingError = error
                this.processingError.kiBurstDiagnostics = this.captureDiagnostics()
                this.stop('frame-identity-error')
                return
            }

            if (!ptsDecision.accepted) {
                this.rejectedPtsCandidates.push(ptsDecision.rejection)
                this.candidateEvaluations.push({
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

            const outcome = this.selector.evaluate({
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
            this.emitOnce('first_complete_candidate', {
                sourceIndex: index,
                pts: decoded.pts,
                ptsTime: decoded.ptsTime,
                pictType: decoded.pictType
            })
            this.previousAcceptedPts = decoded.pts
            this.candidateEvaluations.push({
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

            if (this.selector.candidates.length === 1) this.startObservationWindow()
        }
    }

    parseStderrLine(line) {
        const diagnostic = parseShowinfoFrameLine(line)
        if (!diagnostic) return
        if (diagnostic.stage === 'full') {
            this.fullDiagnostics.set(diagnostic.index, diagnostic)
            this.emitOnce('first_full_frame', { index: diagnostic.index, pts: diagnostic.pts, ptsTime: diagnostic.ptsTime })
        } else if (diagnostic.stage === 'luma') {
            this.lumaDiagnostics.set(diagnostic.index, diagnostic)
            this.emitOnce('first_luma_diagnostic', { index: diagnostic.index, pts: diagnostic.pts, ptsTime: diagnostic.ptsTime })
        } else {
            this.decodedDiagnostics.set(diagnostic.index, diagnostic)
            this.emitOnce('first_decoded_frame', {
                index: diagnostic.index,
                pts: diagnostic.pts,
                ptsTime: diagnostic.ptsTime,
                pictType: diagnostic.pictType
            })
        }
        this.evaluateReadyCandidates()
    }

    // Spawns the decoder. Packets may be fed as soon as this resolves.
    async start() {
        this.startedAtMs = Date.now()
        this.cameraDir = join(this.outputDir, String(this.cameraId))
        this.tempDir = join(this.cameraDir, `.tmp-${this.burstId}`)
        await mkdir(this.cameraDir, { recursive: true })
        await rm(this.tempDir, { recursive: true, force: true })
        await mkdir(this.tempDir, { recursive: true })

        this.nextEvaluateIndex = 0
        this.previousAcceptedPts = null
        let rawBuffer = Buffer.alloc(0)
        let rawFrameIndex = 0
        const lumaFrameBytes = DEFAULT_ANALYSIS_WIDTH * DEFAULT_ANALYSIS_HEIGHT

        const args = buildBurstFfmpegArgs({ candidatePattern: join(this.tempDir, 'candidate-%06d.jpg') })
        const ffmpeg = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        this.ffmpeg = ffmpeg
        this.emitOnce('ffmpeg_spawned', { pid: ffmpeg.pid ?? null })
        let stderr = ''
        let stderrLineBuffer = ''

        ffmpeg.stderr.on('data', chunk => {
            const text = chunk.toString()
            stderr = (stderr + text).slice(-32768)
            stderrLineBuffer += text
            let newlineIndex
            while ((newlineIndex = stderrLineBuffer.indexOf('\n')) >= 0) {
                this.parseStderrLine(stderrLineBuffer.slice(0, newlineIndex))
                stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1)
            }
        })

        ffmpeg.stdout.on('data', chunk => {
            rawBuffer = Buffer.concat([rawBuffer, chunk])
            while (rawBuffer.length >= lumaFrameBytes) {
                const luma = Buffer.from(rawBuffer.subarray(0, lumaFrameBytes))
                rawBuffer = rawBuffer.subarray(lumaFrameBytes)
                const index = rawFrameIndex++
                this.lumaFrames.set(index, luma)
                this.emitOnce('first_raw_luma_frame', { index, bytes: luma.length })
                this.evaluateReadyCandidates()
            }
        })

        this.exitPromise = new Promise((resolve, reject) => {
            ffmpeg.once('error', reject)
            ffmpeg.once('close', code => {
                if (stderrLineBuffer) this.parseStderrLine(stderrLineBuffer)
                if (this.forwardError) reject(this.forwardError)
                else if (this.processingError) reject(this.processingError)
                else if (code === 0 || this.stopRequested) resolve()
                else reject(new Error(`KI Burst ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
            })
        })
        // The rejection is observed in finish(); this keeps an early failure from being unhandled.
        this.exitPromise.catch(() => {})

        ffmpeg.stdin.end(this.sdp)
        this.emitOnce('sdp_written_to_ffmpeg')

        // Only complete access units accepted by H264RtpFrameGate reach the decoder, and a fresh keyframe is requested.
        this.requestKeyFrame()
        this.emitOnce('keyframe_requested')

        if (this.firstCleanWallClockMs === null) {
            this.timers.hardSafety = setTimeout(() => this.stop('hard-safety-timeout'), Math.max(1, this.hardSafetyTimeoutMs - (Date.now() - this.startedAtMs)))
        }
    }

    // Waits for the observation window, then selects and persists the frames.
    async finish() {
        try {
            await this.exitPromise
            await this.forwardQueue
            if (this.forwardError) throw this.forwardError
            if (this.processingError) throw this.processingError

            const { selector, tempDir, cameraDir, burstId } = this
            this.candidateJpegInventory = inspectCandidateJpegFiles(
                await readdir(tempDir),
                selector.candidates.map(candidate => candidate.sourceIndex)
            )
            const inventory = this.candidateJpegInventory
            const existingJpegs = new Set(inventory.existingSourceIndices)
            for (const evaluation of this.candidateEvaluations) {
                evaluation.jpegPresent = existingJpegs.has(evaluation.index)
            }
            this.emit('candidate_jpeg_inventory', {
                files: inventory.files,
                jpegCount: inventory.jpegCount,
                minSourceIndex: inventory.minSourceIndex,
                maxSourceIndex: inventory.maxSourceIndex,
                candidate000086Present: inventory.candidate000086Present,
                metadataSourceIndices: inventory.metadataSourceIndices,
                missingMetadataSourceIndices: inventory.missingMetadataSourceIndices
            })

            const restriction = restrictSelectorCandidatesToExistingJpegs(selector, inventory.existingSourceIndices)
            this.excludedMissingJpegSourceIndices = restriction.removedSourceIndices
            this.emit('candidate_jpeg_eligibility', {
                eligibleCandidateCount: restriction.eligibleSourceIndices.length,
                eligibleSourceIndices: restriction.eligibleSourceIndices,
                excludedMissingJpegSourceIndices: this.excludedMissingJpegSourceIndices
            })

            let selectionResult
            try {
                selectionResult = selector.finalizeBuffered()
            } catch (error) {
                error.kiBurstDiagnostics = this.captureDiagnostics()
                throw error
            }
            const { selected, diagnostics: selectionDiagnostics } = selectionResult
            if (selected.length !== this.frameCount) throw new Error(`KI Burst adaptive selector returned ${selected.length} frames`)
            this.selectedSourceIndices = selected.map(frame => frame.sourceIndex)
            this.emit('candidate_jpeg_selection', {
                selectedSourceIndices: this.selectedSourceIndices,
                allSelectedJpegsPresent: this.selectedSourceIndices.every(index => existingJpegs.has(index))
            })
            this.emit('selection_complete', { at: new Date().toISOString(), selectedSourceIndices: this.selectedSourceIndices })

            for (const source of selected) {
                const decoded = this.decodedDiagnostics.get(source.sourceIndex)
                const full = this.fullDiagnostics.get(source.sourceIndex)
                const lumaDiagnostic = this.lumaDiagnostics.get(source.sourceIndex)
                const luma = this.lumaFrames.get(source.sourceIndex)
                if (!decoded || !full || !lumaDiagnostic || !luma ||
                    decoded.pts !== source.pts || full.pts !== source.pts || lumaDiagnostic.pts !== source.pts) {
                    throw new Error(`KI Burst selected JPEG/luma mapping mismatch for source index ${source.sourceIndex}`)
                }
            }

            let loaded
            try {
                loaded = await loadSelectedCandidateJpegs(tempDir, selected)
            } catch (error) {
                error.kiBurstDiagnostics = this.captureDiagnostics()
                this.emit('candidate_jpeg_read_failed', {
                    message: error.message,
                    selectedSourceIndices: this.selectedSourceIndices,
                    inventory
                })
                throw error
            }
            const paths = []
            for (let i = 0; i < selected.length; i++) {
                const tempPath = join(tempDir, candidateFilenameForSourceIndex(selected[i].sourceIndex))
                const finalPath = join(cameraDir, `frame-${i + 1}.jpg`)
                paths.push(finalPath)
                await rename(tempPath, finalPath)
            }
            this.emit('frames_persisted', { at: new Date().toISOString(), paths })

            return {
                frames: loaded.frames,
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
                firstCleanFrameAt: this.firstCleanWallClockMs ? new Date(this.firstCleanWallClockMs).toISOString() : selectionDiagnostics.firstCleanFrameAt,
                totalBurstDurationMs: Date.now() - this.startedAtMs,
                frameSourceIndices: selected.map(frame => frame.sourceIndex),
                framePts: selected.map(frame => frame.pts),
                framePtsTime: selected.map(frame => frame.ptsTime),
                frameTimestamps: selected.map(frame => frame.observedAt),
                frameTypes: selected.map(frame => frame.pictType),
                frameRawChecksums: selected.map(frame => frame.rawChecksum),
                frameHashes: loaded.frameHashes,
                rtpIntegrity: this.getRtpIntegrity(),
                candidateEvaluations: this.candidateEvaluations,
                rejectedPtsCandidates: this.rejectedPtsCandidates,
                candidateJpegInventory: this.candidateJpegInventory,
                excludedMissingJpegSourceIndices: this.excludedMissingJpegSourceIndices,
                stopReason: this.stopReason
            }
        } finally {
            await this.dispose()
        }
    }

    async dispose() {
        for (const timer of Object.values(this.timers)) if (timer) clearTimeout(timer)
        if (this.ffmpeg && this.ffmpeg.exitCode === null) this.ffmpeg.kill('SIGKILL')
        if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true }).catch(() => {})
    }
}
