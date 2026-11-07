// Wording gate for an inbox task. No Node built-ins: the browser draft
// helper imports this, and pulling in bridge/net.mjs crashes the page
// (Vite externalizes node:http).

export const TASK_MAX = 4000

const BLOCKED_TASK = [
  [/\bsend\b/i, 'sending'],
  [/\b(delete|erase)\b/i, 'deleting'],
  [/\b(buy|purchase|pay|charge)\b/i, 'buying or paying'],
  [/\bdeploy\b/i, 'deploying'],
  [/\bproduction\b/i, 'production changes'],
  [/\bprod\b/i, 'production changes'],
  [/\b(password|credential|api key)\b/i, 'credentials or account secrets'],
  [/\b(change|update|reset)\b[^.]{0,40}\baccount\b/i, 'account changes'],
]

export function normalizeTask(raw) {
  return String(raw ?? '').trim()
}

/** Research, analysis, and drafts only. Effectful wording is refused locally. */
export function taskAllowed(raw) {
  const task = normalizeTask(raw)
  if (!task) return { ok: false, reason: 'The task is empty.' }
  if (task.length > TASK_MAX) {
    return { ok: false, reason: `The task is longer than ${TASK_MAX} characters.` }
  }
  for (const [pattern, why] of BLOCKED_TASK) {
    if (pattern.test(task)) {
      return {
        ok: false,
        reason:
          `This inbox only accepts research, analysis, and drafts. ` +
          `The text looks like ${why}, so it was not sent.`,
      }
    }
  }
  return { ok: true, task }
}
