import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

type Session = {
  configured: boolean
  destination: string | null
  problem?: string | null
  csrf: string
  scope: string
}

type SendResult = {
  ok: boolean
  code: string
  message: string
  requestId?: string
}

function newRequestId() {
  return crypto.randomUUID()
}

/**
 * One confirmed research task to the Jarvis inbox routine.
 * The button is the only send. The model has no tool for this, and the
 * sender key is never fetched into the page.
 */
export function InboxRelay() {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [offline, setOffline] = useState(false)
  const [task, setTask] = useState('')
  const [requestId, setRequestId] = useState(newRequestId)
  const [result, setResult] = useState<SendResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let gone = false
    setOffline(false)
    fetch(`${BRIDGE_HTTP_URL}/inbox/session`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('refused'))))
      .then((body: Session) => {
        if (!gone) setSession(body)
      })
      .catch(() => {
        if (!gone) setOffline(true)
      })
    return () => {
      gone = true
    }
  }, [open])

  const preview = {
    request_id: requestId,
    task: task.trim(),
    hop_count: 0,
  }
  const finished = result?.code === 'accepted' || result?.code === 'rejected' || result?.code === 'uncertain'

  const submit = (acknowledge: boolean) => {
    if (!session?.configured || !session.csrf || busy || finished) return
    setBusy(true)
    fetch(`${BRIDGE_HTTP_URL}/inbox/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jarvis-csrf': session.csrf,
      },
      body: JSON.stringify({
        request_id: requestId,
        task,
        acknowledge_duplicate: acknowledge,
      }),
    })
      .then(async (res) => {
        const body = (await res.json()) as SendResult
        setResult(body)
      })
      .catch(() => {
        setResult({
          ok: false,
          code: 'local',
          message: 'The local bridge did not accept the request. Nothing was retried.',
        })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="inbox-dock">
      <button
        type="button"
        className="inbox-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Inbox task
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="Send one inbox task">
          <p className="inbox-note">
            {session?.scope ??
              'This sends one research task to the Jarvis inbox routine. It does not manage other bots or import old chats.'}
          </p>
          {offline && <p className="inbox-note">The local bridge is not answering. Nothing can be sent.</p>}
          {session?.problem && <p className="inbox-note">{session.problem}</p>}
          {session && !session.configured && !session.problem && (
            <p className="inbox-note">
              The sender is off. On this Windows PC, run scripts\setup-inbox-key.ps1 and paste the
              routine URL and key when it asks. The key is not typed into this page.
            </p>
          )}
          {session?.destination && (
            <p className="inbox-dest">
              Destination: <span>{session.destination}</span>
            </p>
          )}
          <textarea
            className="inbox-task"
            value={task}
            maxLength={4000}
            placeholder="Research, analysis, or a draft. Do not ask it to send, delete, buy, or change an account."
            onChange={(event) => {
              setTask(event.target.value)
              if (finished) {
                setResult(null)
                setRequestId(newRequestId())
              }
            }}
          />
          <pre className="inbox-preview">{JSON.stringify(preview, null, 2)}</pre>
          <p className="inbox-note">
            Confirm Send is the only way this leaves the machine. A 200 means the run was accepted.
            Read the result in this Grok Bot chat. Jarvis does not receive it back over HTTP.
          </p>
          {result && <p className="inbox-result">{result.message}</p>}
          {result?.code === 'duplicate-task' ? (
            <button type="button" className="inbox-send" disabled={busy} onClick={() => submit(true)}>
              Confirm send anyway
            </button>
          ) : (
            <button
              type="button"
              className="inbox-send"
              disabled={!session?.configured || busy || finished || !task.trim()}
              onClick={() => submit(false)}
            >
              {busy ? 'Sending once' : 'Confirm Send'}
            </button>
          )}
          {finished && (
            <button
              type="button"
              className="inbox-send"
              onClick={() => {
                setTask('')
                setResult(null)
                setRequestId(newRequestId())
              }}
            >
              Start another request
            </button>
          )}
        </div>
      )}
    </div>
  )
}
