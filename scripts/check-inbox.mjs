/**
 * Inbox relay policy tests. Mocked HTTP and key material only.
 * Does not contact api2.cursor.sh.
 *
 *   node scripts/check-inbox.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInbox } from '../bridge/inbox.mjs'
import { inboxSettings } from '../bridge/inboxFiles.mjs'
import {
  classifyResult,
  safeLogFields,
  taskAllowed,
  vetWebhookUrl,
} from '../bridge/inboxPolicy.mjs'

const failures = []
const ok = (message) => console.log(`ok   ${message}`)
const fail = (message) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}
const assert = (cond, message) => (cond ? ok(message) : fail(message))

const SECRET = 'SENTINEL_KEY_SHOULD_NOT_LOG'
const GOOD = 'https://api2.cursor.sh/automations/webhook/routine1234'
const PUBLIC = ['8.8.8.8']

function requestId(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function mockRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body ? String(body) : ''
    },
  }
}

function mockReq({ method, url, origin, csrf, json }) {
  const payload = Buffer.from(JSON.stringify(json ?? {}))
  return {
    method,
    url,
    headers: {
      ...(origin ? { origin } : {}),
      ...(csrf ? { 'x-jarvis-csrf': csrf } : {}),
    },
    async *[Symbol.asyncIterator]() {
      if (method === 'POST') yield payload
    },
  }
}

async function call(inbox, req) {
  const res = mockRes()
  await inbox.handle(req, res)
  let json = null
  try {
    json = res.body ? JSON.parse(res.body) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text: res.body }
}

function harness(scripted) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-inbox-'))
  const calls = []
  const logs = []
  let clock = 1_000_000
  const inbox = createInbox({
    csrf: 'a'.repeat(64),
    now: () => clock,
    ledgerFile: join(dir, 'ledger.json'),
    originAllowed: (origin) => origin === 'http://127.0.0.1:5173',
    resolveHost: async () => PUBLIC,
    settings: () => ({ configured: true, destination: GOOD }),
    log: (fields) => logs.push(fields),
    transport: async (input) => {
      calls.push(input)
      const next = scripted.shift()
      if (next === 'timeout') {
        const err = new Error('timed out')
        err.code = 'TIMEOUT'
        throw err
      }
      return next
    },
  })
  return { inbox, calls, logs, dir, setTime: (t) => { clock = t } }
}

const badHost = vetWebhookUrl('https://evil.example/automations/webhook/routine1234', PUBLIC)
assert(!badHost.ok, 'a non-official host is refused')
const httpUrl = vetWebhookUrl('http://api2.cursor.sh/automations/webhook/routine1234', PUBLIC)
assert(!httpUrl.ok, 'plain http is refused')
const queryUrl = vetWebhookUrl(`${GOOD}?x=1`, PUBLIC)
assert(!queryUrl.ok, 'a query string is refused')
const userUrl = vetWebhookUrl('https://user:pass@api2.cursor.sh/automations/webhook/routine1234', PUBLIC)
assert(!userUrl.ok, 'credentials in the URL are refused')
const privateIp = vetWebhookUrl(GOOD, ['127.0.0.1'])
assert(!privateIp.ok, 'a loopback DNS answer is refused')
const missingDns = vetWebhookUrl(GOOD, [])
assert(!missingDns.ok, 'an unresolved host is refused')
const goodUrl = vetWebhookUrl(GOOD, PUBLIC)
assert(goodUrl.ok && goodUrl.href === GOOD, 'the official webhook URL is allowed')

assert(taskAllowed('Summarise the notes and draft a briefing.').ok, 'a draft is allowed')
assert(!taskAllowed('Please send the briefing.').ok, 'a send is refused')
assert(!taskAllowed('Delete the old file.').ok, 'a delete is refused')
assert(!taskAllowed('Buy another seat.').ok, 'a purchase is refused')
assert(!taskAllowed('').ok, 'an empty task is refused')

assert(classifyResult({ status: 200 }) === 'accepted', 'HTTP 200 is accepted')
assert(classifyResult({ status: 302 }) === 'rejected', 'a redirect is not acceptance')
assert(classifyResult({ status: 401 }) === 'rejected', 'HTTP 401 is rejected')
assert(classifyResult({ status: 500 }) === 'rejected', 'HTTP 500 is rejected')
assert(classifyResult({ status: null }) === 'uncertain', 'no status is uncertain')
assert(classifyResult({ status: 0 }) === 'uncertain', 'status 0 is uncertain')
assert(
  !JSON.stringify(safeLogFields({ key: SECRET, task: 'secret body', requestId: 'abc', status: 'accepted' })).includes(SECRET),
  'safe logs drop the key',
)
assert(
  !JSON.stringify(safeLogFields({ task: 'full task body', status: 'accepted' })).includes('full task body'),
  'safe logs drop the task body',
)

{
  const { inbox, calls } = harness([{ status: 200 }])
  const denied = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'https://evil.example',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(1), task: 'Research the notes.' },
  }))
  assert(denied.status === 403 && calls.length === 0, 'a foreign origin is refused before any send')
  const bare = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(1), task: 'Research the notes.' },
  }))
  assert(bare.status === 403 && calls.length === 0, 'a missing Origin is refused')
}

{
  const { inbox, calls, logs, dir } = harness([{ status: 200, key: SECRET, authorization: `Bearer ${SECRET}` }])
  const sent = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: {
      request_id: requestId(2),
      task: '  Research the rollout notes and draft a summary.  ',
      hop_count: 7,
      key: SECRET,
    },
  }))
  assert(sent.status === 200 && sent.json.code === 'accepted', 'HTTP 200 is reported as accepted, not finished')
  assert(calls.length === 1, 'the transport was called once')
  assert(calls[0].body.hop_count === 0, 'hop_count is forced to 0')
  assert(calls[0].body.task === 'Research the rollout notes and draft a summary.', 'the task is trimmed')
  assert(!Object.hasOwn(calls[0].body, 'key'), 'the outgoing body has no key')
  assert(calls[0].url === GOOD, 'the transport target is the official URL')
  const again = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(2), task: 'Research something else entirely.' },
  }))
  assert(again.status === 409 && again.json.code === 'duplicate-id' && calls.length === 1, 'the same request id is not sent twice')
  const ledger = readFileSync(join(dir, 'ledger.json'), 'utf8')
  assert(!ledger.includes(SECRET) && !ledger.includes('Research the rollout'), 'the ledger has no key and no task text')
  assert(ledger.includes(requestId(2)) && ledger.includes('accepted'), 'the ledger records id, hash, and status')
  assert(!JSON.stringify(logs).includes(SECRET), 'logs do not contain the key')
  assert(!JSON.stringify(logs).includes('Research the rollout'), 'logs do not contain the task')
}

{
  const { inbox, calls } = harness([{ status: 500 }, { status: 200 }])
  const first = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(3), task: 'Draft a comparison of the two options.' },
  }))
  assert(first.status === 502 && first.json.code === 'rejected', 'a non-200 is rejected')
  const retry = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(3), task: 'Draft a comparison of the two options.' },
  }))
  assert(retry.json.code === 'duplicate-id' && calls.length === 1, 'a rejected id is not retried')
}

{
  const { inbox, calls } = harness(['timeout', { status: 200 }])
  const timed = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(4), task: 'Analyse the timeline in the notes.' },
  }))
  assert(timed.status === 504 && timed.json.code === 'uncertain', 'a timeout is uncertain')
  const retry = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(4), task: 'Analyse the timeline in the notes.' },
  }))
  assert(retry.json.code === 'duplicate-id' && calls.length === 1, 'a timeout is not retried')
}

{
  const { inbox, calls, setTime } = harness([{ status: 200 }, { status: 200 }])
  const task = 'Research the open questions and draft a short brief.'
  const first = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(5), task },
  }))
  assert(first.json.code === 'accepted' && calls.length === 1, 'the first copy is sent')
  setTime(1_000_000 + 60_000)
  const dup = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(6), task },
  }))
  assert(dup.status === 409 && dup.json.code === 'duplicate-task' && calls.length === 1, 'the same text within 10 minutes warns and does not send')
  const anyway = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(6), task, acknowledge_duplicate: true },
  }))
  assert(anyway.json.code === 'accepted' && calls.length === 2, 'an explicit second confirmation can send the duplicate text once')
}

{
  const { inbox, calls } = harness([{ status: 302 }])
  const redirected = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'a'.repeat(64),
    json: { request_id: requestId(7), task: 'Draft the questions for the review.' },
  }))
  assert(redirected.json.code === 'rejected' && calls.length === 1, 'a redirect status is one attempt and not a success')
}

{
  const { inbox, calls } = harness([{ status: 200 }])
  const bad = await call(inbox, mockReq({
    method: 'POST',
    url: '/inbox/send',
    origin: 'http://127.0.0.1:5173',
    csrf: 'nope',
    json: { request_id: requestId(8), task: 'Research the timeline.' },
  }))
  assert(bad.status === 403 && calls.length === 0, 'a wrong send token is refused')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-inbox-off-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'inbox-webhook.url'), `${GOOD}\n`)
  writeFileSync(join(dir, 'inbox-webhook.dpapi'), 'not-a-real-key\n')
  const settings = inboxSettings(dir)
  if (process.platform === 'win32') {
    assert(settings.configured === true, 'on Windows a URL file plus a key file marks the sender configured')
  } else {
    assert(settings.configured === false, 'the sender stays off when this process is not Windows')
  }
  assert(settings.destination === GOOD, 'the destination preview is the saved URL and not a key')
  assert(!JSON.stringify(settings).includes('not-a-real-key'), 'settings do not load the key file')
}

{
  const setup = readFileSync(new URL('./setup-inbox-key.ps1', import.meta.url), 'utf8')
  const send = readFileSync(new URL('./send-inbox.ps1', import.meta.url), 'utf8')
  const setupCode = setup.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert(setup.includes('ConvertFrom-SecureString'), 'setup uses ConvertFrom-SecureString')
  assert(
    !setupCode.includes('-AsPlainText') && !setupCode.includes('-Key'),
    'setup does not request a plain export or a separate key',
  )
  assert(setup.includes("Read-Host 'Sender key' -AsSecureString"), 'setup collects the key from a hidden prompt')
  assert(send.includes('api2.cursor.sh') && send.includes('AuthenticateAsClient'), 'the sender pins TLS to the official host')
  assert(!send.includes('Write-Output $key') && !send.includes('Write-Host $key'), 'the sender script does not print the key')
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall inbox checks passed')
