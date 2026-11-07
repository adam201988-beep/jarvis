// Bind helpers for the local bridge.
//
// `server.listen(port)` with no host listens on the unspecified address
// (`::` or `0.0.0.0`). On Windows that is every interface, so another machine
// on the LAN can reach /file, /page, /img and /media even though the log line
// says localhost. Binding the literal loopback addresses does not consult DNS,
// so a hosts-file entry for "localhost" cannot move the socket onto a public IP.

/** Addresses this process is willing to accept a TCP connection from. */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  let addr = address.toLowerCase().split('%')[0]
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length)
  return addr === '127.0.0.1' || addr === '::1'
}

const OPTIONAL_IPV6 = new Set([
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EINVAL',
  'ENOTSUP',
])

function closeQuiet(server) {
  try {
    server.close()
  } catch {
    /* not listening */
  }
}

/**
 * Listen on 127.0.0.1 and, when the OS has it, ::1.
 *
 * `create` is called once per address and must return `{ server }` where
 * `server` is an http.Server that is not yet listening. The same port is used
 * for both; port 0 is rejected because the two stacks would not share it.
 * A missing IPv6 loopback is not fatal. Any other bind error closes what was
 * already opened and rejects.
 */
export function listenOnLoopback(port, create) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error(`invalid loopback port ${port}`))
  }

  const hosts = ['127.0.0.1', '::1']
  const listening = []

  const bind = (host) =>
    new Promise((resolve, reject) => {
      const created = create()
      const server = created?.server
      if (!server || typeof server.listen !== 'function') {
        reject(new Error('listenOnLoopback create() must return { server }'))
        return
      }
      const onError = (err) => {
        server.off('listening', onListening)
        closeQuiet(server)
        reject(Object.assign(err, { host }))
      }
      const onListening = () => {
        server.off('error', onError)
        resolve({ ...created, host, server })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.on('connection', (socket) => {
        if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy()
      })
      server.listen({ port, host, ipv6Only: host.includes(':') })
    })

  return (async () => {
    for (const host of hosts) {
      try {
        listening.push(await bind(host))
      } catch (err) {
        if (host === '::1' && OPTIONAL_IPV6.has(err.code)) continue
        for (const item of listening) closeQuiet(item.server)
        throw err
      }
    }
    if (listening.length === 0) {
      throw new Error('could not bind any loopback address')
    }
    return listening
  })()
}
