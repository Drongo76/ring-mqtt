import { readFile } from 'fs/promises'

// Diagnostic aid, not part of the selection: while a KI Burst runs, ffmpeg decodes every frame of
// the observation window (about 60-100 JPEGs), then the burst keeps three and deletes the rest.
// To judge which moment is the best Frame 3 on real events, a sparse, time-ordered sample of those
// candidates is kept next to the burst history. It can never change or delay the burst result.
export const KI_BURST_CANDIDATES_KEEP_DEFAULT = 10
export const KI_BURST_CANDIDATES_STEP_MS_DEFAULT = 500
export const KI_BURST_CANDIDATES_STEP_MS_MIN = 100

// KI_BURST_CANDIDATES_KEEP: how many of the newest bursts keep their candidate sample; 0 = off.
export function resolveKiBurstCandidatesKeep(env = process.env) {
    const raw = env.KI_BURST_CANDIDATES_KEEP
    if (raw === undefined || raw === null || String(raw).trim() === '') return KI_BURST_CANDIDATES_KEEP_DEFAULT
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : KI_BURST_CANDIDATES_KEEP_DEFAULT
}

export function resolveKiBurstCandidatesStepMs(env = process.env) {
    const raw = env.KI_BURST_CANDIDATES_STEP_MS
    if (raw === undefined || raw === null || String(raw).trim() === '') return KI_BURST_CANDIDATES_STEP_MS_DEFAULT
    const value = Number(raw)
    return Number.isFinite(value) && value >= KI_BURST_CANDIDATES_STEP_MS_MIN ? Math.round(value) : KI_BURST_CANDIDATES_STEP_MS_DEFAULT
}

// First candidate at or after each multiple of stepMs; candidates may arrive in any order.
export function pickCandidatesByStep(candidates, stepMs = KI_BURST_CANDIDATES_STEP_MS_DEFAULT) {
    const sorted = (Array.isArray(candidates) ? candidates : [])
        .filter(candidate => Number.isFinite(candidate?.elapsedMs) && Number.isInteger(candidate?.sourceIndex))
        .sort((a, b) => a.elapsedMs - b.elapsedMs || a.sourceIndex - b.sourceIndex)
    const picked = []
    let target = 0
    for (const candidate of sorted) {
        if (candidate.elapsedMs < target) continue
        picked.push(candidate)
        target = Math.floor(candidate.elapsedMs / stepMs) * stepMs + stepMs
    }
    return picked
}

// Returns [{ elapsedMs, sourceIndex, observedAt, jpeg }]; never throws (a missing file is skipped).
export async function readKiBurstCandidateArchive({ tempDir, candidates, filenameForSourceIndex, env = process.env, join }) {
    try {
        if (resolveKiBurstCandidatesKeep(env) === 0) return []
        const picked = pickCandidatesByStep(candidates, resolveKiBurstCandidatesStepMs(env))
        const result = []
        for (const candidate of picked) {
            try {
                const jpeg = await readFile(join(tempDir, filenameForSourceIndex(candidate.sourceIndex)))
                if (jpeg.length) {
                    result.push({
                        elapsedMs: candidate.elapsedMs,
                        sourceIndex: candidate.sourceIndex,
                        observedAt: candidate.observedAt || null,
                        jpeg
                    })
                }
            } catch {
                // Candidate JPEG not on disk: skip it, this is only a sample.
            }
        }
        return result
    } catch {
        return []
    }
}
