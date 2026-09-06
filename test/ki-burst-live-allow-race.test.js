import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { KiBurstController } from '../lib/ki-burst-controller.js'
import { evaluateCandidatePts } from '../lib/streaming/build12-streaming-session.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 500) {
    const started = Date.now()
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for KI Burst race-test condition')
        await delay(2)
    }
}

async function loadWorkerHarness({ parentPort, captureBurstWithCleanup }) {
    const sourceUrl = new URL('../devices/camera-livestream-build12.js', import.meta.url)
    const source = await readFile(sourceUrl, 'utf8')
    const executable = source
        .split('\n')
        .filter(line => !line.startsWith('import '))
        .join('\n')

    class FakeWebrtcConnection {
        constructor(ticket, camera) {
            this.ticket = ticket
            this.camera = camera
        }
    }

    class FakeBuild12StreamingSession {
        constructor(camera, connection) {
            this.camera = camera
            this.connection = connection
            this.stopped = false
            this.stopCalls = 0
        }

        stop() {
            this.stopped = true
            this.stopCalls += 1
        }
    }

    vm.runInNewContext(executable, {
        parentPort,
        workerData: { deviceName: 'Haustür', doorbotId: 123 },
        WebrtcConnection: FakeWebrtcConnection,
        Build12StreamingSession: FakeBuild12StreamingSession,
        captureBurstWithCleanup,
        Buffer,
        Promise,
        setTimeout,
        clearTimeout,
        console
    }, { filename: 'camera-livestream-build12.js' })
}

test('Live Allow OFF during queued dedicated Burst startup must not kill the Burst session', async () => {
    const timeline = []
    const workerCommands = []
    const workerMessages = []
    let controller
    let observationWindowRan = false

    class FakeParentPort extends EventEmitter {
        postMessage(message) {
            workerMessages.push(message)
            if (message.type === 'log_info' && message.data.includes('starting dedicated WebRTC session')) {
                timeline.push('dedicated_start')
            }
            if (message.type === 'log_info' && message.data.includes('Websocket signaling')) {
                timeline.push('signaling_connected')
            }
            if (message.burstId) controller?.handleWorkerMessage(message)
        }
    }

    const parentPort = new FakeParentPort()

    const captureBurstWithCleanup = async ({ session, burstId, options, onCleanup }) => {
        parentPort.postMessage({ type: 'log_info', data: 'Websocket signaling for WebRTC session connected successfully' })
        await delay(8)

        // This is the real build-16 PTS decision helper. One duplicate must be
        // rejected exactly once, while later monotonic candidates remain usable.
        const ptsSequence = [100, 100, 200, 300]
        const accepted = []
        const rejectedPtsCandidates = []
        let previousPts = null

        if (session.stopped) {
            onCleanup()
            return {
                result: null,
                failure: Object.assign(new Error('dedicated Burst session stopped before first clean frame'), {
                    kiBurstDiagnostics: {
                        selectionMode: 'adaptive_buffered',
                        observationWindowMs: options.observationWindowMs,
                        candidateFramesEvaluated: 0,
                        firstCleanFrameAt: null,
                        rejectedPtsCandidates: []
                    }
                })
            }
        }

        for (let sourceIndex = 0; sourceIndex < ptsSequence.length; sourceIndex++) {
            const pts = ptsSequence[sourceIndex]
            const diagnostic = { index: sourceIndex, pts, ptsTime: sourceIndex, observedAt: new Date().toISOString() }
            const decision = evaluateCandidatePts({
                sourceIndex,
                previousPts,
                decoded: diagnostic,
                full: diagnostic,
                luma: diagnostic
            })
            if (!decision.accepted) {
                rejectedPtsCandidates.push(decision.rejection)
                continue
            }
            previousPts = pts
            accepted.push(diagnostic)
        }

        const firstCleanFrameAt = new Date().toISOString()
        observationWindowRan = true
        await delay(35)

        if (session.stopped) {
            onCleanup()
            return {
                result: null,
                failure: Object.assign(new Error('dedicated Burst session stopped during observation window'), {
                    kiBurstDiagnostics: {
                        selectionMode: 'adaptive_buffered',
                        observationWindowMs: options.observationWindowMs,
                        candidateFramesEvaluated: accepted.length,
                        firstCleanFrameAt,
                        rejectedPtsCandidates
                    }
                })
            }
        }

        assert.equal(rejectedPtsCandidates.length, 1)
        assert.equal(rejectedPtsCandidates[0].rejectionReason, 'duplicate_pts')
        assert.deepEqual(accepted.map(item => item.pts), [100, 200, 300])

        const result = {
            frames: [Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('frame-3')],
            paths: ['/tmp/frame-1.jpg', '/tmp/frame-2.jpg', '/tmp/frame-3.jpg'],
            capturedAt: new Date().toISOString(),
            selectionMode: 'adaptive_buffered',
            observationWindowMs: options.observationWindowMs,
            candidateFramesEvaluated: accepted.length,
            frameOffsetsMs: [0, 1000, 2000],
            actualFrameOffsetsMs: [0, 1000, 2000],
            differenceScores: [0, 0.25, 0.4],
            changedBlockRatios: [0, 0.12, 0.18],
            pairwiseDifferenceScores: [0.25, 0.4, 0.5],
            totalDiversityScore: 1.15,
            selectionReasons: ['first_clean_frame', 'motion_displacement', 'motion_displacement'],
            selectionThreshold: 0.08,
            minimumSelectionSeparationMs: 1000,
            firstCleanFrameAt,
            totalBurstDurationMs: 55,
            frameSourceIndices: [0, 2, 3],
            framePts: [100, 200, 300],
            framePtsTime: [0, 2, 3],
            frameTimestamps: accepted.map(item => item.observedAt),
            frameTypes: ['I', 'P', 'P'],
            frameRawChecksums: ['a', 'b', 'c'],
            frameHashes: ['h1', 'h2', 'h3'],
            rtpIntegrity: { acceptedAccessUnits: 4 },
            rejectedPtsCandidates
        }

        session.stop()
        onCleanup()
        return { result, failure: null }
    }

    await loadWorkerHarness({ parentPort, captureBurstWithCleanup })

    const states = []
    controller = new KiBurstController({
        requestTicket: async () => 'ring-ticket',
        sendWorker: message => workerCommands.push(message),
        onState: (status, details) => {
            states.push({ status, details, at: Date.now() })
            if (status === 'capturing') timeline.push('capturing')
        },
        timeoutMs: 220
    })

    const startedAt = Date.now()
    const burstId = await controller.start({ observationWindowMs: 60, workerTimeoutMs: 180 })
    assert.ok(burstId)

    // The main thread logs Live Allow OFF before worker-side startup logs can be
    // observed. The burst command was already posted, so the generic stop arrives
    // behind it on the worker port and can race the newly-created burst session.
    workerCommands.push({ command: 'stop', reason: 'live-allow-off' })
    timeline.push('live_allow_off')

    const preflight = workerCommands.shift()
    assert.equal(preflight.reason, 'ki-burst-preflight')
    parentPort.emit('message', preflight)

    const burstCommand = workerCommands.shift()
    assert.equal(burstCommand.command, 'burst')
    parentPort.emit('message', burstCommand)

    await waitFor(() => timeline.includes('dedicated_start'))

    const liveAllowOff = workerCommands.shift()
    assert.equal(liveAllowOff.reason, 'live-allow-off')
    parentPort.emit('message', liveAllowOff)

    await waitFor(() => states.some(state => state.status === 'complete' || state.status === 'failed'), 400)

    const finalState = states.at(-1)
    assert.equal(finalState.status, 'complete', `expected Burst complete, got ${finalState.status}: ${finalState.details?.error || ''}`)
    assert.ok(finalState.details.firstCleanFrameAt)
    assert.equal(finalState.details.rejectedPtsCandidates.length, 1)
    assert.equal(finalState.details.rejectedPtsCandidates[0].rejectionReason, 'duplicate_pts')
    assert.equal(finalState.details.frameCount, 3)
    assert.deepEqual(finalState.details.framePts, [100, 200, 300])
    assert.equal(observationWindowRan, true)
    assert.ok(Date.now() - startedAt < 220, 'Burst must complete well before the controller deadline')

    assert.ok(timeline.indexOf('capturing') < timeline.indexOf('live_allow_off'))
    assert.ok(timeline.indexOf('live_allow_off') < timeline.indexOf('dedicated_start'))
    assert.ok(timeline.indexOf('dedicated_start') < timeline.indexOf('signaling_connected'))
})
