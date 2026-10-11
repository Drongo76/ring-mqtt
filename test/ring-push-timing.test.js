import test from 'node:test'
import assert from 'node:assert/strict'
import { toEpochMs, describePushTiming, formatPushTiming, describeDetectionSettings } from '../lib/ring-push-timing.js'

test('toEpochMs normalizes seconds, milliseconds and ISO strings', () => {
    assert.equal(toEpochMs(1700000000), 1700000000000)
    assert.equal(toEpochMs(1700000000123), 1700000000123)
    assert.equal(toEpochMs('1700000000123'), 1700000000123)
    assert.equal(toEpochMs('2023-11-14T22:13:20.000Z'), 1700000000000)
    for (const bad of [null, undefined, '', 0, -5, 'abc', NaN]) assert.equal(toEpochMs(bad), null)
})

test('describePushTiming computes camera->cloud and cloud->client latency', () => {
    const push = {
        analytics: { triggered_at: 1700000000000, sent_at: 1700000001200 },
        data: { event: { ding: { detection_type: 'human', subtype: 'human' }, eventito: { timestamp: 1700000000500 } } },
        img: { snapshot_uuid: 'abc' }
    }
    const timing = describePushTiming(push, 1700000002700)
    assert.equal(timing.detectToSendMs, 1200)
    assert.equal(timing.sendToReceiveMs, 1500)
    assert.equal(timing.detectToReceiveMs, 2700)
    assert.equal(timing.detectedAt, 1700000000000)
    assert.equal(timing.detectionType, 'human')
    assert.equal(timing.hasSnapshot, true)
    assert.match(formatPushTiming(timing, 'motion'), /total 2\.70s, type=human/)
})

test('describePushTiming falls back to eventito time and tolerates missing data', () => {
    const timing = describePushTiming({ data: { event: { eventito: { timestamp: 1700000000000 } } } }, 1700000001000)
    assert.equal(timing.detectToReceiveMs, 1000)
    assert.equal(timing.detectToSendMs, null)
    const empty = describePushTiming({}, 1700000001000)
    assert.equal(empty.detectToReceiveMs, null)
    assert.match(formatPushTiming(empty, 'ding'), /total n\/a/)
})

test('describeDetectionSettings returns only existing fields', () => {
    const data = { settings: {
        motion_detection_enabled: true,
        motion_zones: { sensitivity: 5, advanced_object_settings: { object_time_overlap: { day: 1, night: 2 } }, zone1: { vertex1: { x: 0, y: 0 } } },
        pir_settings: { sensitivity_1: 3 },
        unrelated: 'x'
    } }
    assert.deepEqual(describeDetectionSettings(data), {
        motion_detection_enabled: true,
        pir_settings: { sensitivity_1: 3 },
        'motion_zones.sensitivity': 5,
        'motion_zones.advanced_object_settings': { object_time_overlap: { day: 1, night: 2 } },
        'motion_zones.zone1': { vertex1: { x: 0, y: 0 } }
    })
    assert.deepEqual(describeDetectionSettings(undefined), {})
    assert.deepEqual(describeDetectionSettings({ settings: null }), {})
})
