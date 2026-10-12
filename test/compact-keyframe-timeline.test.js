import test from 'node:test'
import assert from 'node:assert/strict'
import { compactRtpIntegrityForHomeAssistant } from '../lib/build12-patch.js'

test('compact RTP integrity keeps the keyframe timeline for the published status attributes', () => {
    const compact = compactRtpIntegrityForHomeAssistant({
        acceptedAccessUnits: 3,
        keyframeTimeline: { packetsSeen: 9, duplicatesPer500ms: { 0: 2 }, truncated: false, events: ['+10 PLI sent', 42, '+20 resync'] }
    })
    assert.deepEqual(compact.keyframeTimeline, { packetsSeen: 9, duplicatesPer500ms: { 0: 2 }, truncated: false, events: ['+10 PLI sent', '+20 resync'] })
    assert.equal('keyframeTimeline' in compactRtpIntegrityForHomeAssistant({}), false)
})
