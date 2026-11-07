// Local loopback endpoint for one confirmed inbox task.
//
// The browser cannot send the webhook itself. Confirm Send posts here, and
// only a click that presents the session token can do that. The Jarvis model
// has no tool that calls this. The sender key never enters this module.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  classifyResult,
  duplicateHash,
  hashTask,
  outgoingBody,
  requestIdAllowed,
  safeLogFields,
  taskAllowed,
  vetWebhookUrl,
} from './inboxPolicy.mjs'

const BODY_MAX = 32 * 1024

function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readLedger(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLedger(file, rows) {
  mkdirSync(dirname(file), { recursive: true })
  const slim = rows.map((row) => ({
    requestId: row.requestId,
    taskHash: row.taskHash,
    at: row.at,
    status: row.status,
  }))
  writeFileSync(file, JSON.stringify(slim), { mode: 0o600 })
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_MAX) return { overflow: true }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return { json: JSON.parse(raw || '{}') }
  } catch {
    return { bad: true }
  }
}

function sendJson(res, status, body, cors) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...cors,
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * @param {object} options
 * @param {() => number} options.now
 * @param {string} options.ledgerFile
 * @param {(host: string) => Promise<string[]>} options.resolveHost
 * @param {() => { configured: boolean, destination: string | null }} options.settings
 * @param {(input: { url: string, body: object, timeoutMs: number }) => Promise<{ status: number | null, error?: string }>} options.transport
 * @param {(origin: string | undefined) => boolean} options.originAllowed
 * @param {(fields: object) => void} [options.log]
 * @param {string} [options.csrf]
 */
export function createInbox(options) {
  const now = options.now ?? (() => Date.now())
  const csrf = options.csrf ?? randomBytes(32).toString('hex')
  const log = options.log ?? (() => {})
  const inflight = new Set()

  const corsFor = (origin) => ({
    vary: 'origin',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, x-jarvis-csrf',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })

  function refuse(res, status, code, message, cors) {
    sendJson(res, status, { ok: false, code, message }, cors)
  }

  async function session(res, cors) {
    const settings = options.settings()
    let destination = null
    let problem = null
    if (settings.configured && settings.destination) {
      let addresses = []
      try {
        addresses = await options.resolveHost('api2.cursor.sh')
      } catch {
        addresses = []
      }
      const vetted = vetWebhookUrl(settings.destination, addresses)
      if (vetted.ok) destination = vetted.href
      else problem = vetted.reason
    }
    sendJson(
      res,
      200,
      {
        ok: true,
        configured: Boolean(destination),
        destination,
        problem,
        csrf,
        scope:
          'One research, analysis, or draft task for the Jarvis inbox routine. ' +
          'This does not manage bots or import chats. HTTP 200 means the run was accepted, ' +
          'not that it finished. The result appears in this Grok Bot chat.',
      },
      cors,
    )
  }

  async function send(req, res, cors) {
    const header = req.headers['x-jarvis-csrf']
    if (!tokensEqual(Array.isArray(header) ? header[0] : header, csrf)) {
      return refuse(res, 403, 'csrf', 'The send token did not match. Reload the page.', cors)
    }
    const body = await readJson(req)
    if (body.overflow) return refuse(res, 413, 'too-large', 'The request is too large.', cors)
    if (body.bad) return refuse(res, 400, 'bad-json', 'The request was not JSON.', cors)

    const settings = options.settings()
    if (!settings.configured || !settings.destination) {
      return refuse(
        res,
        409,
        'not-configured',
        'The inbox sender is off until the Windows setup script has saved a key.',
        cors,
      )
    }

    let addresses = []
    try {
      addresses = await options.resolveHost('api2.cursor.sh')
    } catch {
      addresses = []
    }
    const vetted = vetWebhookUrl(settings.destination, addresses)
    if (!vetted.ok) {
      log(safeLogFields({ status: 'refused-target' }))
      return refuse(res, 409, 'refused-target', vetted.reason, cors)
    }

    const taskCheck = taskAllowed(body.json?.task)
    if (!taskCheck.ok) return refuse(res, 400, 'task', taskCheck.reason, cors)
    const idCheck = requestIdAllowed(body.json?.request_id)
    if (!idCheck.ok) return refuse(res, 400, 'request-id', idCheck.reason, cors)

    const rows = readLedger(options.ledgerFile)
    if (rows.some((row) => row.requestId === idCheck.requestId) || inflight.has(idCheck.requestId)) {
      return refuse(
        res,
        409,
        'duplicate-id',
        'That request id was already used. It will not be sent again.',
        cors,
      )
    }
    const taskHash = hashTask(taskCheck.task)
    if (duplicateHash(rows, taskHash, now()) && body.json?.acknowledge_duplicate !== true) {
      return sendJson(
        res,
        409,
        {
          ok: false,
          code: 'duplicate-task',
          message:
            'The same task text was submitted in the last 10 minutes. It was not sent. ' +
            'Use Confirm send anyway only if you mean to submit it again.',
        },
        cors,
      )
    }

    const record = {
      requestId: idCheck.requestId,
      taskHash,
      at: now(),
      status: 'sending',
    }
    inflight.add(idCheck.requestId)
    writeLedger(options.ledgerFile, [...rows, record])
    const payload = outgoingBody(idCheck.requestId, taskCheck.task)
    let result
    try {
      result = await options.transport({
        url: vetted.href,
        body: payload,
        timeoutMs: 8000,
      })
    } catch (err) {
      result = { status: null, error: err?.code === 'TIMEOUT' ? 'timeout' : 'network' }
    } finally {
      inflight.delete(idCheck.requestId)
    }

    const status = classifyResult(result)
    const latest = readLedger(options.ledgerFile).map((row) =>
      row.requestId === idCheck.requestId ? { ...row, status } : row,
    )
    writeLedger(options.ledgerFile, latest)
    log(
      safeLogFields({
        requestId: idCheck.requestId,
        taskHash: taskHash.slice(0, 12),
        status,
        httpStatus: Number.isInteger(result?.status) ? result.status : 0,
        destinationHost: vetted.host,
        // These are dropped by safeLogFields. They are here so a test can prove it.
        key: result?.key,
        task: taskCheck.task,
        authorization: result?.authorization,
      }),
    )

    if (status === 'accepted') {
      return sendJson(
        res,
        200,
        {
          ok: true,
          code: 'accepted',
          requestId: idCheck.requestId,
          message:
            'Grok Bot accepted the run. That is not the result. Open this Grok Bot chat to read it. ' +
            'This attempt will not be sent again.',
        },
        cors,
      )
    }
    if (status === 'uncertain') {
      return sendJson(
        res,
        504,
        {
          ok: false,
          code: 'uncertain',
          requestId: idCheck.requestId,
          message:
            'The webhook did not return a status. This attempt was not retried and will not be retried. ' +
            'Check this Grok Bot chat before starting a new request id.',
        },
        cors,
      )
    }
    return sendJson(
      res,
      502,
      {
        ok: false,
        code: 'rejected',
        requestId: idCheck.requestId,
        httpStatus: result?.status ?? 0,
        message:
          'The webhook refused the run. A 200 is the only acceptance. This attempt will not be retried.',
      },
      cors,
    )
  }

  return {
    csrf,
    async handle(req, res) {
      const origin = req.headers.origin
      if (!origin || !options.originAllowed(origin)) {
        res.writeHead(403, { vary: 'origin', 'cache-control': 'no-store' })
        res.end('forbidden')
        return
      }
      const cors = corsFor(origin)
      const path = (req.url ?? '/').split('?')[0]
      if (req.method === 'OPTIONS' && (path === '/inbox/session' || path === '/inbox/send')) {
        res.writeHead(204, cors)
        res.end()
        return
      }
      if (req.method === 'GET' && path === '/inbox/session') return session(res, cors)
      if (req.method === 'POST' && path === '/inbox/send') return send(req, res, cors)
      res.writeHead(404, cors)
      res.end()
    },
  }
}

