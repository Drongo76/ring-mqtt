// Reads the kernel's UDP receive statistics of the add-on's network namespace so a burst can
// tell whether packets were dropped locally (socket receive buffer overflow) or on the network.
// Purely diagnostic, linux only, never throws.
import { readFileSync } from 'fs'

export function parseSnmpUdp(text) {
    const lines = String(text || '').split('\n').filter(line => line.startsWith('Udp:'))
    if (lines.length < 2) return null
    const names = lines[0].trim().split(/\s+/).slice(1)
    const values = lines[1].trim().split(/\s+/).slice(1).map(Number)
    const result = {}
    names.forEach((name, index) => { if (Number.isFinite(values[index])) result[name] = values[index] })
    return result
}

// /proc/net/udp: "sl local_address rem_address st tx_queue:rx_queue ... inode ref pointer drops"
export function parseProcNetUdp(text) {
    const sockets = []
    for (const line of String(text || '').split('\n').slice(1)) {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 13) continue
        const port = parseInt(columns[1].split(':')[1], 16)
        const rxQueue = parseInt(columns[4].split(':')[1], 16)
        const drops = Number(columns[columns.length - 1])
        if (Number.isFinite(port) && Number.isFinite(drops)) sockets.push({ port, rxQueue, drops })
    }
    return sockets
}

export function readUdpStats(read = path => readFileSync(path, 'utf8')) {
    const safe = path => { try { return read(path) } catch { return null } }
    const snmp = parseSnmpUdp(safe('/proc/net/snmp'))
    const sockets = parseProcNetUdp(safe('/proc/net/udp'))
    const rmemDefault = Number(String(safe('/proc/sys/net/core/rmem_default') ?? '').trim()) || null
    const rmemMax = Number(String(safe('/proc/sys/net/core/rmem_max') ?? '').trim()) || null
    return { snmp, sockets, rmemDefault, rmemMax }
}

export function describeUdpDelta(before, after) {
    if (!before?.snmp || !after?.snmp) return 'udp stats unavailable'
    const delta = name => (after.snmp[name] ?? 0) - (before.snmp[name] ?? 0)
    const parts = [
        `udp in=${delta('InDatagrams')}`,
        `rcvbufErrors=${delta('RcvbufErrors')}`,
        `inErrors=${delta('InErrors')}`
    ]
    const previous = new Map(before.sockets.map(socket => [socket.port, socket.drops]))
    const dropping = after.sockets
        .map(socket => ({ port: socket.port, drops: socket.drops - (previous.get(socket.port) ?? 0) }))
        .filter(socket => socket.drops > 0)
        .map(socket => `${socket.port}:${socket.drops}`)
    parts.push(`socketDrops=${dropping.length ? dropping.join(',') : 'none'}`)
    parts.push(`udpSockets=${before.sockets.length}->${after.sockets.length}`)
    parts.push(`rmem default=${after.rmemDefault ?? '?'} max=${after.rmemMax ?? '?'}`)
    return parts.join(' ')
}
