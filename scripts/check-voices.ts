/**
 * Regression for the Windows voice picker.
 *
 * Microsoft David, Mark, and Zira must be selectable. The old cycle kept only
 * voices that scored like a named British male, so V on a stock Windows
 * machine always returned "default".
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/check-voices.ts
 */

import {
  cycleSelection,
  isTypingTarget,
  orderVoices,
  previewScript,
  readSaved,
  resolveVoice,
  voiceStatus,
  writeSaved,
  type ListedVoice,
  type VoiceStorage,
} from '../src/lib/browserVoices.ts'

const failures: string[] = []
const ok = (message: string) => console.log(`ok   ${message}`)
const fail = (message: string) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}
const assert = (cond: boolean, message: string) => (cond ? ok(message) : fail(message))

const windows: ListedVoice[] = [
  {
    name: 'Microsoft David Desktop - English (United States)',
    lang: 'en-US',
    voiceURI: 'Microsoft David Desktop - English (United States)',
  },
  {
    name: 'Microsoft Zira Desktop - English (United States)',
    lang: 'en-US',
    voiceURI: 'Microsoft Zira Desktop - English (United States)',
  },
  {
    name: 'Microsoft Mark - English (United States)',
    lang: 'en-US',
    voiceURI: 'Microsoft Mark - English (United States)',
  },
]

const daniel: ListedVoice = {
  name: 'Daniel',
  lang: 'en-GB',
  voiceURI: 'com.apple.voice.compact.en-GB.Daniel',
}

function memory(): VoiceStorage & { raw: () => string | null } {
  let value: string | null = null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
    raw: () => value,
  }
}

const ordered = orderVoices(windows).map((v) => v.name)
assert(
  ordered[0].includes('David') && ordered[1].includes('Mark') && ordered[2].includes('Zira'),
  `David, Mark, then Zira are all selectable (got ${ordered.join(' | ')})`,
)

const stock = voiceStatus(windows, null)
assert(stock.chosen?.name.includes('David') === true, 'default choice on the Windows list is David')
assert(
  stock.short.includes('No British voice'),
  `stock Windows list says no British voice (got ${stock.short})`,
)
assert(
  stock.detail.includes('David') &&
    stock.detail.includes('Mark') &&
    stock.detail.includes('will not be British'),
  'the explanation names the male voices and the American accent',
)
assert(!stock.detail.includes('Zira'), 'Zira is not offered as the closest male voice')

const withDaniel = voiceStatus([daniel, ...windows], null)
assert(withDaniel.chosen?.name === 'Daniel', 'a British Daniel outranks the Windows voices')
assert(withDaniel.short === '' && withDaniel.detail === '', 'no warning when a British voice exists')

const store = memory()
assert(resolveVoice([], readSaved(store.raw())).chosen === null, 'an empty list selects nothing')
const waiting = voiceStatus([], readSaved('Microsoft David Desktop - English (United States)'))
assert(
  waiting.short.includes('Waiting'),
  'an empty list waits instead of pretending a voice was chosen',
)
assert(store.raw() === null, 'resolving an empty list does not write storage')

writeSaved(store, windows[2])
const savedMark = readSaved(store.raw())
const later = resolveVoice(windows, savedMark)
assert(later.usingSaved && later.chosen?.name.includes('Mark') === true, 'a saved Mark is kept once the list arrives')
assert(store.raw()?.includes('Mark') === true, 'loading the list does not replace the saved Mark')

const missing = voiceStatus(windows, readSaved('Daniel'))
assert(missing.short.includes('Saved voice'), 'a missing saved voice is reported')
assert(missing.detail.includes('still remembered'), 'a missing saved voice is not forgotten')
assert(missing.chosen?.name.includes('David') === true, 'speech falls back without erasing the memory')

const legacy = readSaved('Microsoft Mark - English (United States)')
assert(
  resolveVoice(windows, legacy).chosen?.name.includes('Mark') === true,
  'a legacy plain-name preference still matches',
)

let cursor = readSaved(null)
const seen: string[] = []
for (let i = 0; i < 4; i++) {
  const next = cycleSelection(windows, cursor)
  assert(next !== null, `cycle step ${i} returns a voice`)
  seen.push(next?.name ?? '')
  cursor = next
    ? { name: next.name, lang: next.lang, voiceURI: next.voiceURI ?? '' }
    : null
}
assert(seen[0].includes('Mark'), `first cycle from the default David lands on Mark (got ${seen[0]})`)
assert(seen[1].includes('Zira'), `second cycle lands on Zira (got ${seen[1]})`)
assert(seen[2].includes('David'), `third cycle returns to David (got ${seen[2]})`)
assert(cycleSelection([], null) === null, 'cycling an empty list does not invent "default"')

assert(isTypingTarget({ tagName: 'INPUT' }), 'an input is a typing target')
assert(isTypingTarget({ tagName: 'textarea' }), 'a textarea is a typing target')
assert(isTypingTarget({ tagName: 'SELECT' }), 'a select is a typing target')
assert(isTypingTarget({ isContentEditable: true, tagName: 'DIV' }), 'a contenteditable is a typing target')
assert(
  isTypingTarget({
    tagName: 'SPAN',
    closest: (selector: string) => (selector.includes('input') ? {} : null),
  }),
  'a node inside an input is a typing target',
)
assert(!isTypingTarget({ tagName: 'BODY' }), 'the page itself is not a typing target')
assert(!isTypingTarget(null), 'a missing target is not a typing target')

const preview = previewScript('Microsoft David Desktop - English (United States)')
assert(
  preview.text === 'Voice set to Microsoft David Desktop - English. At your service, sir.',
  `preview names the voice without calling a service (got ${preview.text})`,
)
assert(preview.rate === 0.92 && preview.pitch === 0.95, 'preview uses the calm conversation pace')
assert(
  !preview.text.toLowerCase().includes('eleven') && !preview.text.toLowerCase().includes('kokoro'),
  'preview copy does not mention a paid or neural engine',
)

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall voice selection checks passed')
