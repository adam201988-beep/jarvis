import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  VOICE_PREF_KEY,
  orderVoices,
  readSaved,
  sameVoice,
  voiceStatus,
  writeSaved,
  type ListedVoice,
  type SavedVoice,
} from '../lib/browserVoices'
import { previewBrowserVoice } from '../lib/tts'

function listedVoices(): ListedVoice[] {
  if (typeof speechSynthesis === 'undefined') return []
  return speechSynthesis.getVoices().map((v) => ({
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI,
  }))
}

function readPreference(): SavedVoice | null {
  try {
    return readSaved(localStorage.getItem(VOICE_PREF_KEY))
  } catch {
    return null
  }
}

/**
 * The browser voice list is not available on the first paint. Chrome and Edge
 * fill it in later, sometimes only after getVoices() has been called, and
 * sometimes across more than one voiceschanged event. Polling a few times is
 * what makes a late list show up without the user refreshing.
 */
export function VoicePicker() {
  const [open, setOpen] = useState(false)
  const [voices, setVoices] = useState<ListedVoice[]>([])
  const [saved, setSaved] = useState<SavedVoice | null>(null)
  const label = useStore((s) => s.voice)

  useEffect(() => {
    const apply = () => {
      const list = listedVoices()
      const preference = readPreference()
      setVoices(list)
      setSaved(preference)
      const { chosen } = voiceStatus(list, preference)
      useStore.getState().setVoice(chosen?.name ?? '')
    }
    apply()
    const synth = window.speechSynthesis
    synth.addEventListener('voiceschanged', apply)
    const timers = [0, 250, 1000, 3000].map((ms) => window.setTimeout(apply, ms))
    return () => {
      synth.removeEventListener('voiceschanged', apply)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [])

  const status = voiceStatus(voices, saved)
  const ordered = orderVoices(voices)
  const shown = (label || status.chosen?.name || '').replace(/\(.*?\)/g, '').trim()

  const select = (voice: ListedVoice) => {
    try {
      writeSaved(localStorage, voice)
    } catch {
      /* private mode still previews for this page */
    }
    setSaved({
      name: voice.name,
      lang: voice.lang,
      voiceURI: voice.voiceURI ?? '',
    })
    useStore.getState().setVoice(voice.name)
  }

  return (
    <div className="voice-dock">
      <button
        type="button"
        className="voice-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Voices{shown ? ` · ${shown}` : ''}
      </button>
      {status.short && <p className="voice-short">{status.short}</p>}
      {open && (
        <div
          className="voice-picker"
          role="dialog"
          aria-label="Browser voices"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            setOpen(false)
          }}
        >
          {status.detail && <p className="voice-note">{status.detail}</p>}
          {ordered.length > 0 && (
            <ul className="voice-list">
              {ordered.map((voice) => {
                const selected = sameVoice(voice, status.chosen)
                return (
                  <li key={`${voice.voiceURI ?? ''}|${voice.name}|${voice.lang}`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      className={selected ? 'voice-choice is-selected' : 'voice-choice'}
                      onClick={() => select(voice)}
                    >
                      <span className="voice-name">{voice.name}</span>
                      <span className="voice-lang">{voice.lang || 'language unknown'}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <button
            type="button"
            className="voice-preview"
            disabled={!status.chosen}
            onClick={() => previewBrowserVoice()}
          >
            Preview this voice
          </button>
        </div>
      )}
    </div>
  )
}
