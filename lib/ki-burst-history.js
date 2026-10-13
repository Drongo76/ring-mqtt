import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

// Keeps the last KI_BURST_HISTORY_MAX completed bursts (the three published frames plus the
// published status attributes) so that selection, model choice and prompts can be judged on real
// bursts instead of on whichever burst happened to be the latest one.
export const KI_BURST_HISTORY_MAX = 50

const BURST_ID = /^(\d{10,16})-(\d{1,9})$/
const TEMP_PREFIX = '.tmp-'

export function resolveKiBurstHistoryDir({ env = process.env, framePaths = [] } = {}) {
    const configured = env.KI_BURST_HISTORY_DIR
    if (typeof configured === 'string' && configured.trim()) return configured.trim()
    const first = Array.isArray(framePaths) ? framePaths.find(path => typeof path === 'string' && path) : null
    return first ? join(dirname(first), 'history') : null
}

// KI_BURST_HISTORY_KEEP: how many bursts to keep; 0 switches the history off.
export function resolveKiBurstHistoryKeep(env = process.env) {
    const raw = env.KI_BURST_HISTORY_KEEP
    if (raw === undefined || raw === null || String(raw).trim() === '') return KI_BURST_HISTORY_MAX
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : KI_BURST_HISTORY_MAX
}

export function parseKiBurstId(burstId) {
    const match = BURST_ID.exec(String(burstId ?? ''))
    return match ? { timestamp: Number(match[1]), sequence: Number(match[2]) } : null
}

function newestFirst(a, b) {
    return b.timestamp - a.timestamp || b.sequence - a.sequence
}

export async function listKiBurstHistory(historyDir) {
    let names
    try {
        names = await readdir(historyDir)
    } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
    }
    return names
        .map(name => ({ name, ...parseKiBurstId(name) }))
        .filter(entry => Number.isFinite(entry.timestamp))
        .sort(newestFirst)
        .map(entry => entry.name)
}

// A crash between mkdir and rename leaves a temporary directory behind. Only old ones are removed,
// so an archive that is still being written is never touched.
const STALE_TEMPORARY_MS = 10 * 60 * 1000

async function removeStaleTemporaryDirectories(historyDir, nowMs) {
    const names = await readdir(historyDir).catch(() => [])
    await Promise.all(names
        .filter(name => name.startsWith(TEMP_PREFIX))
        .map(async name => {
            const path = join(historyDir, name)
            const info = await stat(path).catch(() => null)
            if (info && nowMs - info.mtimeMs > STALE_TEMPORARY_MS) {
                await rm(path, { recursive: true, force: true }).catch(() => {})
            }
        }))
}

export async function pruneKiBurstHistory(historyDir, keep = KI_BURST_HISTORY_MAX) {
    const names = await listKiBurstHistory(historyDir)
    const surplus = names.slice(Math.max(0, keep))
    await Promise.all(surplus.map(name => rm(join(historyDir, name), { recursive: true, force: true })))
    return surplus
}

export async function archiveKiBurst({ historyDir, burstId, frames, attributes = {}, keep = KI_BURST_HISTORY_MAX, now = () => new Date() }) {
    if (!historyDir) throw new Error('KI Burst history directory is not configured')
    if (!parseKiBurstId(burstId)) throw new Error(`KI Burst history refuses unexpected burst id: ${burstId}`)
    if (!Array.isArray(frames) || frames.length === 0 || frames.some(frame => !frame || frame.length === 0)) {
        throw new Error('KI Burst history needs non-empty frames')
    }

    await mkdir(historyDir, { recursive: true })
    const target = join(historyDir, burstId)
    // Write next to the target and rename, so a reader never sees a half-written burst.
    const temp = join(historyDir, `${TEMP_PREFIX}${burstId}-${process.pid}-${Math.random().toString(16).slice(2)}`)
    try {
        await mkdir(temp)
        await Promise.all(frames.map((frame, index) => writeFile(join(temp, `frame-${index + 1}.jpg`), frame)))
        await writeFile(join(temp, 'meta.json'), JSON.stringify({ savedAt: now().toISOString(), ...attributes }, null, 2))
        await rm(target, { recursive: true, force: true })
        await rename(temp, target)
    } finally {
        await rm(temp, { recursive: true, force: true }).catch(() => {})
    }

    const pruned = await pruneKiBurstHistory(historyDir, keep)
    await removeStaleTemporaryDirectories(historyDir, now().getTime())
    return { path: target, pruned }
}
