/**
 * Spoken phrase -> inbox draft. No network, no key, no microphone.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/check-inbox-draft.ts
 */

import { readFileSync } from 'node:fs'
import { taskAllowed } from '../bridge/inboxPolicy.mjs'
import {
  considerFinal,
  draftSpokenLine,
  resetDraftMemory,
  type DraftInput,
} from '../src/lib/inboxDraft.ts'

const failures: string[] = []
const ok = (message: string) => console.log(`ok   ${message}`)
const fail = (message: string) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}
const assert = (cond: boolean, message: string) => (cond ? ok(message) : fail(message))

const final = (text: string, now = 1_000_000): DraftInput => ({
  text,
  stage: 'final',
  echo: false,
  source: 'speech',
  now,
})

resetDraftMemory()

const crm = considerFinal(final('Ask Jarvis command for a CRM NFC Search status'))
assert(crm.type === 'draft', 'ask Jarvis command prepares a draft')
if (crm.type === 'draft') {
  assert(crm.target === 'CRM NFC Search', `CRM NFC Search is the target (got ${crm.target})`)
  assert(crm.task.includes('CRM NFC Search'), 'the draft keeps the CRM NFC Search request')
  assert(crm.task.includes('Launch Budget') === false, 'the CRM draft does not name Launch Budget')
  assert(taskAllowed(crm.task).ok, 'the CRM draft is allowed by the existing send gate')
  assert(!crm.task.toLowerCase().includes('chrome'), 'the draft does not mention Chrome')
  assert(!crm.spoken.toLowerCase().includes('finished'), 'the spoken line does not claim the task finished')
  assert(crm.spoken.includes('Grok Bot chat'), 'the spoken line says the reply is in the Grok Bot chat')
  assert(!crm.spoken.toLowerCase().includes('chrome'), 'the spoken line does not mention Chrome')
}

resetDraftMemory()
const budget = considerFinal(final('Delegate to DriveConnect for a Launch Budget DC update'))
assert(budget.type === 'draft' && budget.target === 'Launch Budget', 'delegate to DriveConnect names Launch Budget')
if (budget.type === 'draft') {
  assert(budget.task.includes('Launch Budget DC update'), 'the Launch Budget wording is preserved')
  assert(budget.task.startsWith('Research for Jarvis command.'), 'the draft is a research request for Jarvis command')
  assert(taskAllowed(budget.task).ok, 'the Launch Budget draft is allowed by the existing send gate')
}

resetDraftMemory()
const getCrm = considerFinal(final('Get a CRM NFC Search status'))
assert(getCrm.type === 'draft' && getCrm.target === 'CRM NFC Search', 'get a CRM NFC Search status prepares that draft')

resetDraftMemory()
const check = considerFinal(final('Check the Launch Budget DC update'))
assert(check.type === 'draft' && check.target === 'Launch Budget', 'check the Launch Budget DC update prepares that draft')

resetDraftMemory()
const whats = considerFinal(final("What's the status of CRM NFC Search"))
assert(whats.type === 'draft' && whats.target === 'CRM NFC Search', "what's the status of CRM NFC Search prepares that draft")
resetDraftMemory()
const curly = considerFinal(final('What\u2019s the status of Launch Budget'))
assert(curly.type === 'draft' && curly.target === 'Launch Budget', 'a curly apostrophe still matches')

resetDraftMemory()
const hey = considerFinal(final('Hey Jarvis, ask Jarvis command for a CRM NFC Search status'))
assert(hey.type === 'draft' && hey.target === 'CRM NFC Search', 'a leading Hey Jarvis is ignored for matching')

resetDraftMemory()
const both = considerFinal(final('Ask Jarvis command for a CRM NFC Search status and a Launch Budget update'))
assert(
  both.type === 'draft' && both.target === 'CRM NFC Search and Launch Budget',
  'both bot names are kept distinct',
)

resetDraftMemory()
const interim = considerFinal({ ...final('Ask Jarvis command for a CRM NFC Search status'), stage: 'interim' })
assert(interim.type === 'ignore', 'an interim caption does not prepare a draft')

const echo = considerFinal({ ...final('Ask Jarvis command for a CRM NFC Search status'), echo: true })
assert(echo.type === 'ignore', 'an echo of synthesized speech does not prepare a draft')

const typed = considerFinal({ ...final('Ask Jarvis command for a CRM NFC Search status'), source: 'typing' })
assert(typed.type === 'ignore', 'typing the phrase does not prepare a draft')

resetDraftMemory()
assert(considerFinal(final("I'll check the launch budget thread")).type === 'chat', 'a first-person aside is ordinary chat')
assert(considerFinal(final('Open Chrome and make sure the Claude extension is installed')).type === 'chat', 'a Chrome suggestion is not an inbox request')
assert(considerFinal(final("What's the weather today")).type === 'chat', 'an ordinary question is not an inbox request')
assert(considerFinal(final('We were talking about the launch budget yesterday')).type === 'chat', 'background chat about the budget is not a draft')

resetDraftMemory()
const once = considerFinal(final('Ask Jarvis command for a CRM NFC Search status', 5_000))
const twice = considerFinal(final('Ask Jarvis command for a CRM NFC Search status', 5_000 + 30_000))
assert(once.type === 'draft' && twice.type === 'duplicate', 'the same finished request is not drafted twice')
const later = considerFinal(final('Ask Jarvis command for a Launch Budget update', 5_000 + 30_000))
assert(later.type === 'draft' && later.target === 'Launch Budget', 'a different bot still prepares a new draft')

resetDraftMemory()
const risky = considerFinal(final('Ask Jarvis command to delete the old CRM NFC Search notes'))
assert(risky.type === 'refuse', 'an effectful request is refused instead of drafted')
if (risky.type === 'refuse') {
  assert(/delet/i.test(risky.reason), 'the refusal says why')
}

const line = draftSpokenLine('CRM NFC Search')
assert(!/status is|completed|done|installed/i.test(line), 'the acknowledgement does not invent a result')

const draftSource = readFileSync(new URL('../src/lib/inboxDraft.ts', import.meta.url), 'utf8')
assert(!/inboxPolicy|net\.mjs|node:http/.test(draftSource), 'the browser draft helper does not import the Node webhook stack')

const prompt = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8')
assert(prompt.includes('Do not open Chrome'), 'the model is told not to open Chrome for these bots')
assert(prompt.includes('Never invent'), 'the model is told not to invent a bot status')
assert(prompt.includes('Grok Bot chat'), 'the model is told the reply is in the Grok Bot chat')

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall spoken inbox draft checks passed')
