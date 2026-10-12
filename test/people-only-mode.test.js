import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePeopleOnlyCommand, buildPeopleOnlySettings, readPeopleOnlyState } from '../lib/people-only-mode.js'

test('parsePeopleOnlyCommand accepts on/off in any case and rejects everything else', () => {
    assert.equal(parsePeopleOnlyCommand('ON'), true)
    assert.equal(parsePeopleOnlyCommand(' off '), false)
    for (const bad of ['', 'toggle', 'true', null, undefined, 1]) assert.equal(parsePeopleOnlyCommand(bad), null)
})

test('buildPeopleOnlySettings produces the Ring device settings payload', () => {
    assert.deepEqual(buildPeopleOnlySettings(false), { motion_settings: { advanced_motion_detection_human_only_mode: false } })
    assert.deepEqual(buildPeopleOnlySettings(true), { motion_settings: { advanced_motion_detection_human_only_mode: true } })
})

test('readPeopleOnlyState maps the reported setting and tolerates missing data', () => {
    assert.equal(readPeopleOnlyState({ settings: { advanced_motion_detection_human_only_mode: true } }), 'ON')
    assert.equal(readPeopleOnlyState({ settings: { advanced_motion_detection_human_only_mode: false } }), 'OFF')
    for (const data of [undefined, {}, { settings: {} }, { settings: { advanced_motion_detection_human_only_mode: 'yes' } }]) {
        assert.equal(readPeopleOnlyState(data), null)
    }
})
