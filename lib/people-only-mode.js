// Pure helpers for the Ring "People Only" motion mode (advanced_motion_detection_human_only_mode).
// With the mode on, Ring only reports motion after it classified a person, which delays
// the event; turning it off lets Ring report any motion right away.

export function parsePeopleOnlyCommand(message) {
    const command = String(message ?? '').trim().toLowerCase()
    if (command === 'on') return true
    if (command === 'off') return false
    return null
}

export function buildPeopleOnlySettings(enabled) {
    return { motion_settings: { advanced_motion_detection_human_only_mode: Boolean(enabled) } }
}

// Returns 'ON' / 'OFF', or null when Ring does not report the setting for this camera.
export function readPeopleOnlyState(deviceData) {
    const value = deviceData?.settings?.advanced_motion_detection_human_only_mode
    if (typeof value !== 'boolean') return null
    return value ? 'ON' : 'OFF'
}
