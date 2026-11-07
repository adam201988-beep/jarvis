// Policy for the one outbound Jarvis inbox relay.
//
// The only permitted target is a Grok Bot routine webhook. Official docs say
// to copy "POST to" from the routine's Webhook section and send
// Authorization: Bearer <key>. A 200 means the run was accepted, not that the
// Bot finished. The URL shape used by that product is
// https://api2.cursor.sh/automations/webhook/<id> with no query string
// (Cursor's make-bot-ui skill and the routine webhook examples). The id is
// never guessed: it has to be the one the user copied.
//
// This module does not send, store, or see the sender key.

import { createHash } from 'node:crypto'
import { blockedAddress } from './net.mjs'
import { TASK_MAX, normalizeTask, taskAllowed } from './taskText.mjs'

export { TASK_MAX, normalizeTask, taskAllowed }

export const WEBHOOK_HOST = 'api2.cursor.sh'
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000
export const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const WEBHOOK_PATH = /^\/automations\/webhook\/[A-Za-z0-9_-]{8,200}$/

export function hashTask(task) {
  return createHash('sha256').update(task, 'utf8').digest('hex')
}

export function requestIdAllowed(raw) {
  const id = String(raw ?? '').trim().toLowerCase()
  if (!REQUEST_ID.test(id)) return { ok: false, reason: 'The request id is not valid.' }
  return { ok: true, requestId: id }
}

/**
 * Syntactic allowlist plus an optional resolved-address check.
 * `addresses` is required at send time. A missing list is not a pass.
 */
export function vetWebhookUrl(raw, addresses) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    return { ok: false, reason: 'The saved webhook URL is not a URL.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'The webhook URL must be https.' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'The webhook URL must not contain a username or password.' }
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'The webhook URL must not contain a query or fragment.' }
  }
  if (url.port && url.port !== '443') {
    return { ok: false, reason: 'The webhook URL must use port 443.' }
  }
  if (url.hostname.toLowerCase() !== WEBHOOK_HOST) {
    return {
      ok: false,
      reason: `The webhook host must be ${WEBHOOK_HOST}. Other hosts are refused.`,
    }
  }
  if (!WEBHOOK_PATH.test(url.pathname) || url.pathname.includes('%')) {
    return {
      ok: false,
      reason: 'The webhook path must be /automations/webhook/<id> copied from the routine.',
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: 'The webhook host did not resolve to a public address.' }
  }
  for (const ip of addresses) {
    if (blockedAddress(ip)) {
      return { ok: false, reason: 'The webhook host resolved to a private or local address.' }
    }
  }
  return {
    ok: true,
    href: `https://${WEBHOOK_HOST}${url.pathname}`,
    host: WEBHOOK_HOST,
    addresses,
  }
}

export function outgoingBody(requestId, task) {
  return { request_id: requestId, task, hop_count: 0 }
}

/**
 * HTTP 200 is the only accepted wake. Redirects are not followed and are not
 * success. No status (timeout, reset) is uncertain and must not be retried.
 */
export function classifyResult(result) {
  const status = Number(result?.status)
  if (status === 200) return 'accepted'
  if (!Number.isInteger(status) || status === 0) return 'uncertain'
  return 'rejected'
}

export function duplicateHash(rows, taskHash, now) {
  return rows.some(
    (row) => row.taskHash === taskHash && now - Number(row.at) < DUPLICATE_WINDOW_MS,
  )
}

const LOG_DROP = new Set([
  'key',
  'authorization',
  'task',
  'body',
  'header',
  'headers',
  'csrf',
  'token',
])

/** A log line may carry ids and statuses. It never carries the task or a secret. */
export function safeLogFields(event) {
  const out = {}
  for (const [key, value] of Object.entries(event ?? {})) {
    if (LOG_DROP.has(key.toLowerCase())) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}
