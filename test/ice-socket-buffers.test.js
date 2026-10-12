import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { enlargeIceReceiveBuffers, describeReceiveBuffers, ICE_RECEIVE_BUFFER_BYTES } from '../lib/streaming/ice-socket-buffers.js'

function fakeSocket(port, size = 212992) {
    const socket = {
        port,
        size,
        set: [],
        address: () => ({ port }),
        getRecvBufferSize: () => socket.size,
        setRecvBufferSize: bytes => { socket.set.push(bytes); socket.size = bytes }
    }
    return socket
}

const fakePc = (...sockets) => ({
    iceTransports: [{ connection: { nominated: { protocol: { transport: { socket: sockets[0] } } }, protocols: sockets.map(socket => ({ transport: { socket } })) } }]
})

test('enlarges the receive buffer of the nominated and all gathered ICE sockets once each', () => {
    const a = fakeSocket(43517)
    const b = fakeSocket(43518)
    const results = enlargeIceReceiveBuffers(fakePc(a, b))
    assert.deepEqual(a.set, [ICE_RECEIVE_BUFFER_BYTES])
    assert.deepEqual(b.set, [ICE_RECEIVE_BUFFER_BYTES])
    assert.deepEqual(results.map(entry => [entry.port, entry.before, entry.after]), [
        [43517, 212992, ICE_RECEIVE_BUFFER_BYTES],
        [43518, 212992, ICE_RECEIVE_BUFFER_BYTES]
    ])
    assert.equal(describeReceiveBuffers(results), `ice recvbuf: port 43517 212992->${ICE_RECEIVE_BUFFER_BYTES}; port 43518 212992->${ICE_RECEIVE_BUFFER_BYTES}`)
})

test('an already large buffer is left alone', () => {
    const socket = fakeSocket(1, ICE_RECEIVE_BUFFER_BYTES * 2)
    enlargeIceReceiveBuffers(fakePc(socket))
    assert.deepEqual(socket.set, [])
})

test('socket errors and missing ICE internals never throw', () => {
    const broken = { address: () => ({ port: 9 }), getRecvBufferSize: () => 1, setRecvBufferSize: () => { throw new Error('EPERM') } }
    const results = enlargeIceReceiveBuffers(fakePc(broken))
    assert.equal(results[0].error, 'EPERM')
    assert.equal(describeReceiveBuffers(results), 'ice recvbuf: port 9 error=EPERM')
    assert.deepEqual(enlargeIceReceiveBuffers({}), [])
    assert.deepEqual(enlargeIceReceiveBuffers(null), [])
    assert.equal(describeReceiveBuffers([]), 'ice recvbuf: no sockets found')
})

test('a real UDP socket gets a larger kernel receive buffer', async t => {
    const socket = createSocket('udp4')
    t.after(() => socket.close())
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    const [entry] = enlargeIceReceiveBuffers(fakePc(socket))
    assert.equal(entry.error, null)
    assert.ok(entry.after > entry.before || entry.before >= ICE_RECEIVE_BUFFER_BYTES, `${entry.before} -> ${entry.after}`)
    assert.equal(socket.getRecvBufferSize(), entry.after)
})

async function receivedFromBlockedBurst(enlarge) {
    // The receiver cannot read while the burst is sent (event loop busy), exactly like the real
    // case where the camera floods its backlog: whatever exceeds the kernel buffer is dropped.
    const receiver = createSocket('udp4')
    const sender = createSocket('udp4')
    await new Promise(resolve => receiver.bind(0, '127.0.0.1', resolve))
    let received = 0
    receiver.on('message', () => { received++ })
    if (enlarge) enlargeIceReceiveBuffers(fakePc(receiver))
    const payload = Buffer.alloc(1200)
    const port = receiver.address().port
    await new Promise(resolve => {
        // send synchronously in one tick so the receiver's 'message' handler cannot run meanwhile
        let pending = 600
        for (let i = 0; i < 600; i++) sender.send(payload, port, '127.0.0.1', () => { if (--pending === 0) resolve() })
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    const size = receiver.getRecvBufferSize()
    receiver.close()
    sender.close()
    return { received, size }
}

test('an enlarged receive buffer survives a burst that overflows the default buffer', async t => {
    const normal = await receivedFromBlockedBurst(false)
    const enlarged = await receivedFromBlockedBurst(true)
    if (enlarged.size <= normal.size) return t.skip(`kernel caps the buffer (${enlarged.size}); net.core.rmem_max too small to compare`)
    assert.ok(normal.received < 600, `default buffer already held every packet (${normal.received})`)
    assert.ok(enlarged.received > normal.received, `enlarged ${enlarged.received} vs default ${normal.received}`)
})
