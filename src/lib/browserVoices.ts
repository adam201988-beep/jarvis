/**
 * Choosing a free browser voice.
 *
 * The old picker kept only voices that scored like a named British male
 * (Daniel, Oliver, Google UK English Male, and so on). A voice had to score
 * 40 or more to be cycled. Microsoft David, Mark, and Zira — the voices
 * Windows actually installs — score as ordinary English and were dropped, so
 * V always reported "default" and never changed anything.
 *
 * Ranking is still "closer to a calm British male first". The list the user
 * can select is every voice the browser reports.
 */

export const VOICE_PREF_KEY = 'jarvis.voice'

export type ListedVoice = {
  name: string
  lang: string
  voiceURI?: string
}

export type SavedVoice = {
  name: string
  lang: string
  voiceURI: string
}

const BRITISH_NAME =
  /\b(daniel|oliver|arthur|jamie|malcolm|brian|reed|rocko|eddy)\b/i
const MALE_NAME = /\b(daniel|oliver|arthur|jamie|malcolm|brian|reed|rocko|eddy|david|mark|guy|george|ryan|james)\b/i
const FEMALE_NAME =
  /\b(zira|hazel|flo|sandy|shelley|kate|serena|fiona|moira|karen|tessa|samantha|zoe|allison|ava|susan|linda|heera|catherine|susan|aria)\b/i
const NOVELTY =
  /grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/i

export function isBritishVoice(v: ListedVoice): boolean {
  if (/^en[-_](gb|uk)\b/i.test(v.lang)) return true
  const n = v.name.toLowerCase()
  return n.includes('google uk english male') || BRITISH_NAME.test(n)
}

export function isLikelyMale(v: ListedVoice): boolean {
  if (FEMALE_NAME.test(v.name)) return false
  return MALE_NAME.test(v.name)
}

/** Higher is closer to the character. Never used to hide a voice. */
export function voiceScore(v: ListedVoice): number {
  const n = v.name.toLowerCase()
  let score = 0
  if (n.startsWith('daniel') || n.includes('google uk english male')) score += 100
  else if (/\b(oliver|arthur|jamie|malcolm|brian)\b/i.test(n)) score += 80
  else if (/\b(reed|rocko|eddy)\b/i.test(n)) score += 40
  else if (/\b(david|mark|guy|george|ryan|james)\b/i.test(n)) score += 18

  if (n.includes('premium')) score += 30
  else if (n.includes('enhanced')) score += 20

  if (/^en[-_](gb|uk)\b/i.test(v.lang)) score += 25
  else if (/^en\b/i.test(v.lang)) score += 5

  if (NOVELTY.test(n)) score -= 200
  if (FEMALE_NAME.test(n)) score -= 30
  if (v.lang && !/^en\b/i.test(v.lang)) score -= 40
  return score
}

export function orderVoices(voices: ListedVoice[]): ListedVoice[] {
  return [...voices].sort((a, b) => {
    const byScore = voiceScore(b) - voiceScore(a)
    if (byScore !== 0) return byScore
    const byName = a.name.localeCompare(b.name)
    if (byName !== 0) return byName
    return a.lang.localeCompare(b.lang)
  })
}

export function sameVoice(a: ListedVoice, b: ListedVoice | SavedVoice | null): boolean {
  if (!b || !b.name) return false
  if (a.voiceURI && b.voiceURI && a.voiceURI === b.voiceURI) return true
  if (a.name !== b.name) return false
  if (a.lang && b.lang && a.lang !== b.lang) return false
  return true
}

export function readSaved(raw: string | null): SavedVoice | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Partial<SavedVoice>
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        return {
          name: parsed.name,
          lang: typeof parsed.lang === 'string' ? parsed.lang : '',
          voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : '',
        }
      }
    } catch {
      /* a voice name that happens to start with a brace */
    }
  }
  return { name: text, lang: '', voiceURI: '' }
}

export function savedRecord(v: ListedVoice): SavedVoice {
  return { name: v.name, lang: v.lang, voiceURI: v.voiceURI ?? '' }
}

export function serializeSaved(v: ListedVoice): string {
  return JSON.stringify(savedRecord(v))
}

export type VoiceStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function writeSaved(storage: VoiceStorage, voice: ListedVoice) {
  storage.setItem(VOICE_PREF_KEY, serializeSaved(voice))
}

export function resolveVoice(
  voices: ListedVoice[],
  saved: SavedVoice | null,
): { chosen: ListedVoice | null; usingSaved: boolean } {
  const ordered = orderVoices(voices)
  if (saved) {
    const hit = ordered.find((v) => sameVoice(v, saved))
    if (hit) return { chosen: hit, usingSaved: true }
  }
  return { chosen: ordered[0] ?? null, usingSaved: false }
}

/** The next voice in rank order, wrapping. Null when the browser has no list yet. */
export function cycleSelection(
  voices: ListedVoice[],
  saved: SavedVoice | null,
): ListedVoice | null {
  const ordered = orderVoices(voices)
  if (!ordered.length) return null
  const { chosen } = resolveVoice(voices, saved)
  const index = ordered.findIndex((v) => sameVoice(v, chosen))
  return ordered[(index + 1) % ordered.length]
}

export function voiceStatus(voices: ListedVoice[], saved: SavedVoice | null): {
  chosen: ListedVoice | null
  usingSaved: boolean
  /** One line for the HUD. Empty when nothing needs saying. */
  short: string
  /** The sentence shown in the picker. */
  detail: string
} {
  const { chosen, usingSaved } = resolveVoice(voices, saved)
  if (!voices.length) {
    return {
      chosen: null,
      usingSaved: false,
      short: 'Waiting for the browser to list voices',
      detail:
        'The browser has not listed any voices yet. They often arrive a moment after the page opens. Open this list again if it is still empty.',
    }
  }

  const savedMissing = Boolean(saved?.name) && !voices.some((v) => sameVoice(v, saved))
  if (savedMissing && saved) {
    return {
      chosen,
      usingSaved: false,
      short: 'Saved voice is not in this browser',
      detail: `The saved voice “${saved.name}” is not in this browser’s list. It is still remembered, and it will be used if it appears. Until then, ${chosen ? chosen.name : 'the browser default'} is what will speak.`,
    }
  }

  if (!voices.some(isBritishVoice)) {
    const males = orderVoices(voices).filter(isLikelyMale)
    const maleLine = males.length
      ? `Closest male ${males.length === 1 ? 'voice' : 'voices'}: ${males
          .slice(0, 3)
          .map((v) => v.name)
          .join(', ')}. The accent will not be British.`
      : 'None of the listed voices is a male voice. The accent will not be British.'
    return {
      chosen,
      usingSaved,
      short: 'No British voice is installed in this browser',
      detail: `No British voice is installed in this browser. ${maleLine}`,
    }
  }

  return { chosen, usingSaved, short: '', detail: '' }
}

/** The one preview line. Rate and pitch match the conversation voice. */
export function previewScript(voiceName: string | null): {
  text: string
  rate: number
  pitch: number
} {
  const label = (voiceName ?? 'the browser default').replace(/\(.*?\)/g, '').trim() || 'the browser default'
  return {
    text: `Voice set to ${label}. At your service, sir.`,
    rate: 0.92,
    pitch: 0.95,
  }
}

/** True when a key event is aimed at somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as {
    tagName?: string
    isContentEditable?: boolean
    closest?: (selector: string) => unknown
  }
  if (el.isContentEditable) return true
  const tag = el.tagName?.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (typeof el.closest === 'function') {
    return Boolean(el.closest('input, textarea, select, [contenteditable]'))
  }
  return false
}
