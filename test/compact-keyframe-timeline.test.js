import test from 'node:test'
import assert from 'node:assert/strict'
import { compactRtpIntegrityForHomeAssistant, boundTimelineEvents, MAX_TIMELINE_ATTRIBUTE_CHARS } from '../lib/build12-patch.js'

test('compact RTP integrity keeps the keyframe timeline for the published status attributes', () => {
    const compact = compactRtpIntegrityForHomeAssistant({
        acceptedAccessUnits: 3,
        keyframeTimeline: { packetsSeen: 9, duplicatesPer500ms: { 0: 2 }, truncated: false, events: ['+10 PLI sent', 42, '+20 resync'] }
    })
    assert.deepEqual(compact.keyframeTimeline, { packetsSeen: 9, duplicatesPer500ms: { 0: 2 }, truncated: false, events: ['+10 PLI sent', '+20 resync'] })
    assert.equal('keyframeTimeline' in compactRtpIntegrityForHomeAssistant({}), false)
})

test('published timeline stays far below the 16 KB Home Assistant attribute limit', () => {
    const longEvent = '+4951 au drop reason=reorder-timeout-no-keyframe-start idrStart=no pkts=112 missing=0 marker=yes nals=1,6'
    const events = Array.from({ length: 150 }, () => longEvent)
    const bounded = boundTimelineEvents(events)
    const chars = bounded.reduce((sum, event) => sum + event.length, 0)
    assert.ok(chars <= MAX_TIMELINE_ATTRIBUTE_CHARS + 100, String(chars))
    assert.match(bounded.at(-1), /more events not published/)
    assert.deepEqual(boundTimelineEvents(['+1 a', '+2 b']), ['+1 a', '+2 b'])
})
