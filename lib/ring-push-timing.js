// Pure helpers that describe how long a Ring motion/ding push notification
// needed to reach ring-mqtt and which detection settings the camera reports.
// No I/O and no dependency on Ring libraries so they are fully unit-testable.

const MS_THRESHOLD = 1e11 // epoch values below this are seconds, above are milliseconds

export function toEpochMs(value) {
    if (value === null || value === undefined || value === '') return null
    let number = Number(value)
    if (!Number.isFinite(number)) {
        number = Date.parse(String(value))
        if (!Number.isFinite(number)) return null
        return number
    }
    if (number <= 0) return null
    return number < MS_THRESHOLD ? Math.round(number * 1000) : Math.round(number)
}

function diff(later, earlier) {
    return later !== null && earlier !== null ? later - earlier : null
}

export function describePushTiming(pushData, receivedAtMs = Date.now()) {
    const analytics = pushData?.analytics || {}
    const ding = pushData?.data?.event?.ding || {}
    const triggeredAt = toEpochMs(analytics.triggered_at)
    const sentAt = toEpochMs(analytics.sent_at)
    const eventAt = toEpochMs(pushData?.data?.event?.eventito?.timestamp)
    const createdAt = toEpochMs(ding.created_at)
    const detectedAt = triggeredAt ?? eventAt ?? createdAt

    return {
        detectionType: ding.detection_type ?? pushData?.data?.event?.eventito?.type ?? null,
        subtype: ding.subtype ?? null,
        hasSnapshot: Boolean(pushData?.img?.snapshot_uuid),
        triggeredAt, sentAt, eventAt, createdAt, detectedAt, receivedAt: receivedAtMs,
        detectToSendMs: diff(sentAt, detectedAt),
        sendToReceiveMs: diff(receivedAtMs, sentAt),
        detectToReceiveMs: diff(receivedAtMs, detectedAt)
    }
}

const fmt = (ms) => ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`

export function formatPushTiming(timing, kind) {
    return `${kind} push timing: detected->Ring sent ${fmt(timing.detectToSendMs)}, ` +
        `Ring sent->received ${fmt(timing.sendToReceiveMs)}, ` +
        `total ${fmt(timing.detectToReceiveMs)}, ` +
        `type=${timing.detectionType ?? 'n/a'}, subtype=${timing.subtype ?? 'n/a'}, snapshot=${timing.hasSnapshot ? 'yes' : 'no'}`
}

// Fields that influence when and what Ring reports as motion. Only fields that
// really exist in the camera data are returned; nothing is guessed or defaulted.
const DETECTION_FIELDS = [
    ['motion_detection_enabled'],
    ['advanced_motion_detection_enabled'],
    ['advanced_motion_detection_human_only_mode'],
    ['enable_pir_validation'],
    ['pir_settings'],
    ['pir_motion_zones'],
    ['motion_zones', 'sensitivity'],
    ['motion_zones', 'active_motion_filter'],
    ['motion_zones', 'advanced_object_settings'],
    ['motion_zones', 'zone1'],
    ['motion_zones', 'zone2'],
    ['motion_zones', 'zone3'],
    ['video_settings', 'hevc_enabled']
]

export function describeDetectionSettings(deviceData) {
    const settings = deviceData?.settings
    const result = {}
    if (!settings || typeof settings !== 'object') return result
    for (const path of DETECTION_FIELDS) {
        let value = settings
        for (const key of path) {
            value = value !== null && typeof value === 'object' ? value[key] : undefined
        }
        if (value !== undefined) result[path.join('.')] = value
    }
    return result
}
