/**
 * Prove the bridge and the Vite dev server accept only loopback connections.
 *
 * Does not send a conversation, does not read Claude credentials, and does not
 * start a turn. The bridge is launched with an empty home directory and with
 * API-key-shaped environment variables removed.
 *
 *   node scripts/check-loopback.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopbackAddress, listenOnLoopback } from '../bridge/loopback.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function fail(message) {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

function ok(message) {
  console.log(`ok   ${message}`)
}

function assert(cond, message) {
  if (cond) ok(message)
  else fail(message)
}

function nonLoopbackAddresses() {
  const found = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      found.push(entry.address)
    }
  }
  return found
}

function probe(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('timeout')
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve('connected')
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      resolve(err.code || 'error')
    })
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  return port
}

async function checkHelper() {
  assert(isLoopbackAddress('127.0.0.1'), '127.0.0.1 is loopback')
  assert(isLoopbackAddress('::1'), '::1 is loopback')
  assert(isLoopbackAddress('::ffff:127.0.0.1'), 'IPv4-mapped loopback is loopback')
  assert(!isLoopbackAddress('::ffff:10.0.0.8'), 'IPv4-mapped LAN address is not loopback')
  assert(!isLoopbackAddress('0.0.0.0'), 'unspecified IPv4 is not loopback')
  assert(!isLoopbackAddress('192.168.1.20'), 'LAN address is not loopback')
  assert(!isLoopbackAddress(''), 'empty address is not loopback')

  const port = await freePort()
  const bound = await listenOnLoopback(port, () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('loopback')
    })
    return { server }
  })
  try {
    const addresses = bound.map((item) => item.server.address()?.address)
    assert(addresses.includes('127.0.0.1'), `helper bound 127.0.0.1 (got ${addresses.join(', ')})`)
    assert(
      addresses.every((address) => address === '127.0.0.1' || address === '::1'),
      `helper addresses are loopback only (${addresses.join(', ')})`,
    )
    assert((await probe('127.0.0.1', port)) === 'connected', 'helper accepts 127.0.0.1')
    const v6 = await probe('::1', port)
    if (addresses.includes('::1')) {
      assert(v6 === 'connected', 'helper accepts ::1')
    } else {
      ok(`IPv6 loopback not available (${v6})`)
    }
    for (const address of nonLoopbackAddresses()) {
      const result = await probe(address, port)
      assert(result !== 'connected', `helper does not accept ${address} (${result})`)
    }
  } finally {
    await Promise.all(
      bound.map(
        (item) =>
          new Promise((resolve) => item.server.close(() => resolve())),
      ),
    )
  }
}

function scrubbedEnv(extra) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key]
  }
  return env
}

function waitFor(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${pattern}\n${text.slice(-2000)}`))
    }, timeoutMs)
    const onData = (chunk) => {
      text += chunk.toString()
      if (text.includes(pattern)) {
        clearTimeout(timer)
        resolve(text)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`exited ${code} before ${pattern}\n${text.slice(-2000)}`))
    })
  })
}

function httpGet(host, port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path: '/health',
        headers,
        family: host.includes(':') ? 6 : 4,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function checkBridge() {
  const port = await freePort()
  const home = mkdtempSync(join(tmpdir(), 'jarvis-empty-home-'))
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: root,
    env: scrubbedEnv({
      HOME: home,
      USERPROFILE: home,
      JARVIS_BRIDGE_PORT: String(port),
      JARVIS_ALLOW_WRITES: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const banner = await waitFor(child, 'writes disabled', 30000)
    assert(banner.includes('127.0.0.1'), 'bridge banner names 127.0.0.1')
    assert(!/0\.0\.0\.0/.test(banner), 'bridge banner does not name 0.0.0.0')
    assert(banner.includes('writes disabled'), 'bridge stays read-only')

    const health = await httpGet('127.0.0.1', port)
    assert(health.status === 200, `GET /health on 127.0.0.1 is 200 (${health.status})`)
    assert(
      health.body.includes('"ok":true') && health.body.includes('"tts":false'),
      'health reports no ElevenLabs key',
    )

    const denied = await httpGet('127.0.0.1', port, { origin: 'https://evil.example' })
    assert(denied.status === 403, `foreign Origin is refused (${denied.status})`)

    if (banner.includes('[::1]')) {
      const v6 = await httpGet('::1', port)
      assert(v6.status === 200, `GET /health on ::1 is 200 (${v6.status})`)
    }

    for (const address of nonLoopbackAddresses()) {
      const result = await probe(address, port)
      assert(result !== 'connected', `bridge does not accept ${address} (${result})`)
    }

    const { default: WebSocket } = await import('ws')
    const socketResult = (headers) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers })
        const timer = setTimeout(() => {
          ws.terminate()
          resolve('timeout')
        }, 3000)
        ws.once('open', () => {
          clearTimeout(timer)
          ws.close()
          resolve('open')
        })
        ws.once('unexpected-response', (_req, res) => {
          clearTimeout(timer)
          resolve(res.statusCode)
        })
        ws.once('error', () => {
          clearTimeout(timer)
          resolve('error')
        })
      })
    const foreignSocket = await socketResult({ Origin: 'https://evil.example' })
    assert(foreignSocket !== 'open', `foreign websocket was not accepted (${foreignSocket})`)
    const bareSocket = await socketResult()
    assert(bareSocket !== 'open', `websocket with no Origin was not accepted (${bareSocket})`)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    rmSync(home, { recursive: true, force: true })
  }
}

async function checkViteRejectsPublicHost() {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', '5199', '--strictPort'],
    { cwd: root, env: scrubbedEnv({}), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const output = await new Promise((resolve) => {
    let text = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ code: null, text: text + '\n(timeout)' })
    }, 20000)
    child.stdout.on('data', (chunk) => {
      text += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      text += chunk.toString()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, text })
    })
  })
  assert(
    output.code !== 0 && output.text.includes('refuses to bind'),
    `Vite refuses --host 0.0.0.0 (exit ${output.code})`,
  )
}

async function checkVite() {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort', '--port', String(port)],
    {
      cwd: root,
      env: scrubbedEnv({ PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  try {
    const banner = await waitFor(child, 'Local:', 90000)
    assert(banner.includes('127.0.0.1'), 'Vite prints 127.0.0.1')
    assert(!/Network:/.test(banner), 'Vite does not print a Network URL')
    const local = await probe('127.0.0.1', port)
    assert(local === 'connected', 'Vite accepts 127.0.0.1')
    for (const address of nonLoopbackAddresses()) {
      const result = await probe(address, port)
      assert(result !== 'connected', `Vite does not accept ${address} (${result})`)
    }
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
}

console.log('loopback checks')
try {
  await checkHelper()
  await checkBridge()
  await checkViteRejectsPublicHost()
  await checkVite()
} catch (err) {
  fail(err?.stack || String(err))
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall loopback checks passed')
