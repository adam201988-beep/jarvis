/**
 * Turn one finished spoken request into an Inbox draft.
 *
 * This does not send. Interim captions, echoes of Jarvis's own voice, and
 * typing never reach a draft. A sentence that is not an explicit request is
 * left for ordinary conversation.
 *
 * Phrases that prepare a draft, after a leading "Jarvis":
 * - "Ask Jarvis command for a CRM NFC Search status"
 * - "Delegate to DriveConnect for a Launch Budget update"
 * - "Get a CRM NFC Search status"
 * - "Check the Launch Budget DC update"
 * - "What's the status of CRM NFC Search"
 */

import { taskAllowed } from '../../bridge/inboxPolicy.mjs'

export type DraftInput = {
  text: string
  stage: 'final' | 'interim'
  echo: boolean
  source: 'speech' | 'typing'
  now: number
}

export type DraftDecision =
  | { type: 'chat' }
  | { type: 'ignore' }
  | { type: 'duplicate' }
  | { type: 'refuse'; reason: string }
  | { type: 'draft'; task: string; target: string; spoken: string }

const DUP_MS = 2 * 60 * 1000

let lastDraft: { task: string; at: number } | null = null

export function resetDraftMemory() {
  lastDraft = null
}

export function draftSpokenLine(target: string) {
  return (
    `Draft ready for ${target}. It is on the screen. Confirm send if it should go. ` +
    'The reply comes back in the Grok Bot chat, not by voice.'
  )
}

function clean(text: string) {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function stripVocative(text: string) {
  return text.replace(/^(?:hey\s+)?jarvis\b[,:]?\s*/i, '').trim()
}

function targetsIn(text: string): string[] {
  const found: string[] = []
  if (/crm\s+nfc(?:\s+search)?/i.test(text)) found.push('CRM NFC Search')
  if (/launch\s+budget/i.test(text)) found.push('Launch Budget')
  return found
}

function build(target: string, request: string, now: number): DraftDecision {
  const task = `Research for Jarvis command. Target bot: ${target}. Request: ${request}`
  const allowed = taskAllowed(task)
  if (!allowed.ok) return { type: 'refuse', reason: allowed.reason }
  if (lastDraft && lastDraft.task === task && now - lastDraft.at < DUP_MS) {
    return { type: 'duplicate' }
  }
  lastDraft = { task, at: now }
  return { type: 'draft', task, target, spoken: draftSpokenLine(target) }
}

function fromAsk(stripped: string, now: number): DraftDecision | null {
  const ask = stripped.match(
    /^(?:please\s+)?(?:ask|tell)\s+(?:the\s+)?jarvis\s+command(?:\s+bot)?\b\s*[:,]?\s*(?:to\s+|for\s+|about\s+)?([\s\S]*)$/i,
  )
  if (!ask) return null
  const request = clean(ask[1] ?? '')
  if (!request) {
    return { type: 'refuse', reason: 'Say what Jarvis command should research.' }
  }
  const named = targetsIn(request)
  const target = named.length ? named.join(' and ') : 'Jarvis command'
  return build(target, request, now)
}

function fromDelegate(stripped: string, now: number): DraftDecision | null {
  const delegated = stripped.match(
    /^(?:please\s+)?delegate\s+(?:this\s+)?to\s+(?:the\s+)?drive\s*connect(?:\s+bots?)?\b\s*[:,]?\s*(?:to\s+|for\s+|about\s+)?([\s\S]*)$/i,
  )
  if (!delegated) return null
  const request = clean(delegated[1] ?? '')
  if (!request) {
    return { type: 'refuse', reason: 'Say what DriveConnect should research.' }
  }
  const named = targetsIn(request)
  const target = named.length ? named.join(' and ') : 'Jarvis command'
  return build(target, request, now)
}

function fromNamedBot(stripped: string, now: number): DraftDecision | null {
  if (/^(?:i'll|i will|i am|i'm|we|we're|we are)\b/i.test(stripped)) return null
  const named = targetsIn(stripped)
  if (!named.length) return null
  const imperative =
    /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:get(?:\s+me)?|check|ask(?:\s+for)?|tell me|what(?:'s| is|s)|how(?:'s| is))\b/i.test(
      stripped,
    )
  const shortStatus =
    stripped.split(/\s+/).length <= 12 &&
    /^(?:please\s+)?(?:the\s+)?(?:crm\s+nfc(?:\s+search)?|launch\s+budget(?:\s+dc)?)\b.*\b(status|update)\b/i.test(
      stripped,
    )
  if (!imperative && !shortStatus) return null
  return build(named.join(' and '), stripped, now)
}

export function considerFinal(input: DraftInput): DraftDecision {
  if (input.source === 'typing' || input.stage === 'interim' || input.echo) {
    return { type: 'ignore' }
  }
  const stripped = stripVocative(clean(input.text))
  if (!stripped) return { type: 'chat' }
  return (
    fromAsk(stripped, input.now) ??
    fromDelegate(stripped, input.now) ??
    fromNamedBot(stripped, input.now) ?? { type: 'chat' }
  )
}

export type PublishedDraft =
  | { nonce: number; type: 'draft'; task: string; target: string }
  | { nonce: number; type: 'refuse'; reason: string }

type Listener = (event: PublishedDraft) => void

let nonce = 0
const listeners = new Set<Listener>()

export function publishInboxDraft(
  event:
    | { type: 'draft'; task: string; target: string }
    | { type: 'refuse'; reason: string },
) {
  const published = { ...event, nonce: ++nonce } as PublishedDraft
  for (const listener of listeners) listener(published)
}

export function subscribeInboxDraft(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
