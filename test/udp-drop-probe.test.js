import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSnmpUdp, parseProcNetUdp, readUdpStats, describeUdpDelta } from '../lib/streaming/udp-drop-probe.js'

const snmp = (inDatagrams, rcvbufErrors, inErrors) => `Ip: Forwarding DefaultTTL\nIp: 1 64\nUdp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors\nUdp: ${inDatagrams} 7 ${inErrors} 500 ${rcvbufErrors} 0 0 0 0\n`

const procNetUdp = (drops) => `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  120: 00000000:C350 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 12345 2 0000000000000000 0
  121: 0100007F:4E21 00000000:0000 07 00000000:0000FA00 00:00000000 00000000     0        0 12346 2 0000000000000000 ${drops}
`

test('parses the UDP counters from /proc/net/snmp', () => {
    assert.deepEqual(
        { rcvbuf: parseSnmpUdp(snmp(100, 3, 4)).RcvbufErrors, inErrors: parseSnmpUdp(snmp(100, 3, 4)).InErrors, inDatagrams: parseSnmpUdp(snmp(100, 3, 4)).InDatagrams },
        { rcvbuf: 3, inErrors: 4, inDatagrams: 100 }
    )
    assert.equal(parseSnmpUdp('nothing'), null)
})

test('parses per-socket port, receive queue and drops from /proc/net/udp', () => {
    assert.deepEqual(parseProcNetUdp(procNetUdp(12)), [
        { port: 0xC350, rxQueue: 0, drops: 0 },
        { port: 0x4E21, rxQueue: 0xFA00, drops: 12 }
    ])
})

test('delta reports datagrams, receive buffer errors and dropping sockets', () => {
    const read = (snmpText, procText) => path => ({
        '/proc/net/snmp': snmpText,
        '/proc/net/udp': procText,
        '/proc/sys/net/core/rmem_default': '212992\n',
        '/proc/sys/net/core/rmem_max': '212992\n'
    })[path]
    const before = readUdpStats(read(snmp(100, 1, 1), procNetUdp(2)))
    const after = readUdpStats(read(snmp(3250, 41, 43), procNetUdp(42)))
    assert.equal(describeUdpDelta(before, after), 'udp in=3150 rcvbufErrors=40 inErrors=42 socketDrops=20001:40 udpSockets=2->2 rmem default=212992 max=212992')
})

test('missing /proc files never throw', () => {
    const stats = readUdpStats(() => { throw new Error('ENOENT') })
    assert.equal(describeUdpDelta(stats, stats), 'udp stats unavailable')
})
