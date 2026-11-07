// Where the inbox URL and DPAPI blob live, and how Windows sends once.
//
// The key file is not read here. PowerShell decrypts it and performs the POST.
// This process only sees the URL and the status code that comes back.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInbox } from './inbox.mjs'

export function inboxDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Jarvis')
  }
  return join(homedir(), '.jarvis')
}

export function inboxSettings(dir = inboxDir()) {
  const urlFile = join(dir, 'inbox-webhook.url')
  const keyFile = join(dir, 'inbox-webhook.dpapi')
  let destination = null
  try {
    const text = readFileSync(urlFile, 'utf8').trim()
    destination = text || null
  } catch {
    destination = null
  }
  const configured =
    process.platform === 'win32' && existsSync(keyFile) && Boolean(destination)
  return { configured, destination }
}

export async function resolvePublicHost(host) {
  const records = await lookup(host, { all: true })
  return records.map((record) => record.address)
}

const sendScript = fileURLToPath(new URL('../scripts/send-inbox.ps1', import.meta.url))

export function windowsTransport() {
  return function transport({ url, body, timeoutMs }) {
    return new Promise((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sendScript],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      // stderr is discarded. It must not be logged; a failure string can quote input.
      child.stderr.on('data', () => {})
      const timer = setTimeout(() => {
        child.kill()
        resolve({ status: null, error: 'timeout' })
      }, timeoutMs + 2000)
      child.on('error', () => {
        clearTimeout(timer)
        resolve({ status: null, error: 'network' })
      })
      child.on('close', () => {
        clearTimeout(timer)
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
        try {
          const parsed = JSON.parse(line)
          resolve({
            status: Number(parsed.status) || 0,
            error: typeof parsed.error === 'string' ? parsed.error : null,
          })
        } catch {
          resolve({ status: null, error: 'network' })
        }
      })
      child.stdin.write(JSON.stringify({ url, body, timeoutSec: Math.ceil(timeoutMs / 1000) }))
      child.stdin.end()
    })
  }
}

export function createBridgeInbox({ originAllowed, log, dir, transport, resolveHost, ledgerFile, csrf }) {
  const root = dir ?? inboxDir()
  return createInbox({
    csrf,
    ledgerFile: ledgerFile ?? join(root, 'inbox-ledger.json'),
    originAllowed,
    log,
    resolveHost: resolveHost ?? resolvePublicHost,
    settings: () => inboxSettings(root),
    transport:
      transport ??
      (process.platform === 'win32'
        ? windowsTransport()
        : async () => ({ status: null, error: 'not-configured' })),
  })
}
