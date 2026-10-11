import { parentPort } from 'worker_threads'
import { firstValueFrom } from 'rxjs'
import { take } from 'rxjs/operators'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { StreamingSession } from './streaming-session.js'
import { H264RtpFrameGate, parseRtpPacket } from './h264-rtp-frame-gate.js'
import { BurstAnalyzer } from './burst-analyzer.js'

export {
    DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS,
    DEFAULT_KI_BURST_CANDIDATE_INTERVAL_MS,
    buildBurstFfmpegArgs,
    candidateFilenameForSourceIndex,
    evaluateCandidatePts,
    getObservationStopDelayMs,
    inspectCandidateJpegFiles,
    loadSelectedCandidateJpegs,
    parseShowinfoFrameLine,
    restrictSelectorCandidatesToExistingJpegs
} from './burst-analyzer.js'
import { DEFAULT_KI_BURST_HARD_SAFETY_TIMEOUT_MS } from './burst-analyzer.js'

export function getVideoOnlySdp(sdp, videoPort) {
    const videoSection = sdp
        .split('\nm=')
        .slice(1)
        .map(section => `m=${section}`)
        .find(section => section.startsWith('m=video '))

    if (!videoSection) throw new Error('Ring WebRTC answer did not contain a video section')
    return videoSection.replace(/m=video \d+/, `m=video ${videoPort}`)
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

export class Build12StreamingSession extends StreamingSession {
    async captureJpegBurst({
        burstId,
        frameCount = 3,
        outputDir = '/data/ki-burst',
        minSeparationMs,
        selectionThreshold,
        observationWindowMs,
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
        emitOnce('burst_started', { at: new Date(burstStartedAtMs).toISOString(), hardSafetyTimeoutMs })
        let answerTimeout
        const answerRemainingMs = Math.max(1, hardDeadline - Date.now())
        emitOnce('waiting_for_sdp_answer', { at: new Date().toISOString(), answerRemainingMs })
        const ringSdp = await Promise.race([
            firstValueFrom(this.connection.onCallAnswered),
            firstValueFrom(this.onCallEnded),
            new Promise((_, reject) => {
                answerTimeout = setTimeout(() => {
                    emitOnce('sdp_answer_timeout', { at: new Date().toISOString(), hardSafetyTimeoutMs })
                    reject(new Error(`KI Burst WebRTC answer exceeded hard safety timeout ${hardSafetyTimeoutMs} ms`))
                }, answerRemainingMs)
            })
        ]).finally(() => clearTimeout(answerTimeout))
        if (!ringSdp) throw new Error('Ring call ended before KI Burst video became available')
        emitOnce('sdp_answer_received', { at: new Date().toISOString(), sdpLength: ringSdp.length })

        const gate = new H264RtpFrameGate({ requestKeyFrame: () => this.requestKeyFrame() })
        let videoSubscription
        const analyzer = new BurstAnalyzer({
            burstId,
            cameraId: this.camera.id,
            outputDir,
            sdp: getVideoOnlySdp(ringSdp, videoPort),
            ffmpegPath: pathToFfmpeg,
            sendPacket: packet => this.videoSplitter.send(packet, { port: videoPort }),
            requestKeyFrame: () => this.requestKeyFrame(),
            getRtpIntegrity: () => gate.snapshotStats(),
            frameCount,
            minSeparationMs,
            selectionThreshold,
            observationWindowMs,
            hardSafetyTimeoutMs: Math.max(1, hardDeadline - Date.now()),
            emit: (stage, details) => emitBurstDiagnostic(burstId, stage, details),
            onStop: () => videoSubscription?.unsubscribe()
        })

        try {
            await analyzer.start()

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
                analyzer.feed(result.packets)
            })
            this.addSubscriptions(videoSubscription)
            this.onCallEnded.pipe(take(1)).subscribe(() => analyzer.stop('ring-call-ended'))

            return await analyzer.finish()
        } finally {
            videoSubscription?.unsubscribe()
            gate.stop()
            await analyzer.dispose()
        }
    }
}
