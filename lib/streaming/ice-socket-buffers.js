// The camera sends a backlog of video right after the first keyframe within a few milliseconds.
// The ICE UDP socket's default receive buffer (net.core.rmem_default, ~208 KiB) overflows and the
// kernel silently drops packets (measured: RcvbufErrors on the ICE socket, 32% of datagrams in a
// burst), which destroys the first keyframe. werift offers no option for this, so the receive
// buffer of the sockets it created is enlarged once ICE exists.

export const ICE_RECEIVE_BUFFER_BYTES = 4 * 1024 * 1024

function collectSockets(pc) {
    const sockets = new Set()
    const transports = Array.isArray(pc?.iceTransports) ? pc.iceTransports : []
    for (const iceTransport of transports) {
        const connection = iceTransport?.connection
        const nominated = connection?.nominated?.protocol?.transport?.socket
        if (nominated) sockets.add(nominated)
        for (const protocol of connection?.protocols ?? []) {
            if (protocol?.transport?.socket) sockets.add(protocol.transport.socket)
        }
    }
    return [...sockets]
}

// Returns one entry per socket that could be inspected; never throws.
export function enlargeIceReceiveBuffers(pc, bytes = ICE_RECEIVE_BUFFER_BYTES) {
    const results = []
    for (const socket of collectSockets(pc)) {
        const entry = { port: null, before: null, after: null, error: null }
        try {
            entry.port = socket.address().port
            entry.before = socket.getRecvBufferSize()
            if (entry.before < bytes) socket.setRecvBufferSize(bytes)
            entry.after = socket.getRecvBufferSize()
        } catch (error) {
            entry.error = String(error?.message || error)
        }
        results.push(entry)
    }
    return results
}

export function describeReceiveBuffers(results) {
    if (!results.length) return 'ice recvbuf: no sockets found'
    return 'ice recvbuf: ' + results
        .map(entry => entry.error
            ? `port ${entry.port ?? '?'} error=${entry.error}`
            : `port ${entry.port} ${entry.before}->${entry.after}`)
        .join('; ')
}
