/**
 * Load the Vite page in headless Chrome with speech APIs missing.
 * Fails if the ignition screen does not render, or if the console reports
 * the browser trying to use a Node built-in.
 *
 *   node scripts/check-boot.mjs http://127.0.0.1:5173
 *
 * Does not start the bridge, the microphone, Claude, or a webhook.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const pageUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const port = 9223
const chromeBin = process.env.CHROME_BIN ?? 'google-chrome'
const outDir = process.env.BOOT_SMOKE_DIR ?? '/tmp/jarvis-boot'
mkdirSync(outDir, { recursive: true })

const chrome = spawn(
  chromeBin,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-software-rasterizer',
    `--user-data-dir=${outDir}/profile`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore', env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '' } },
)

let socket
const failures = []
const consoleErrors = []

function fail(message) {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

async function cdp(method, params = {}) {
  const id = cdp.next++
  const result = new Promise((resolve, reject) => {
    cdp.wait.set(id, { resolve, reject })
  })
  socket.send(JSON.stringify({ id, method, params }))
  return result
}
cdp.next = 1
cdp.wait = new Map()

try {
  let version
  for (let i = 0; i < 80; i++) {
    try {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())
      break
    } catch {
      await delay(150)
    }
  }
  if (!version) throw new Error('Chrome debugging port did not open')

  const tab = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then((r) => r.json())
  socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && cdp.wait.has(msg.id)) {
      const pending = cdp.wait.get(msg.id)
      cdp.wait.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const text = msg.params?.exceptionDetails?.exception?.description
        ?? msg.params?.exceptionDetails?.text
        ?? 'exception'
      consoleErrors.push(text)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
      consoleErrors.push(text)
    }
  })

  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
      if (window.speechSynthesis) {
        window.speechSynthesis.getVoices = () => [];
        window.speechSynthesis.speak = () => {};
      }
    `,
  })
  await cdp('Page.navigate', { url: pageUrl })
  await delay(2500)

  const root = await cdp('Runtime.evaluate', {
    expression: `document.getElementById('root')?.innerText ?? ''`,
    returnByValue: true,
  })
  const text = root.result?.value ?? ''
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outDir}/boot.png`, Buffer.from(shot.data, 'base64'))
  writeFileSync(`${outDir}/console.txt`, consoleErrors.join('\n\n'))

  const nodeHttp = consoleErrors.some((line) => /node:http/.test(line))
  if (nodeHttp) fail('the page threw because node:http was pulled into the browser')
  if (!/INITIALISE/i.test(text)) fail(`ignition text was not rendered (saw: ${JSON.stringify(text).slice(0, 240)})`)
  else console.log('ok   INITIALISE is on screen before any mic or model call')
  if (!nodeHttp && /INITIALISE/i.test(text)) console.log(`ok   screenshot ${outDir}/boot.png`)
} catch (err) {
  fail(err?.stack || String(err))
} finally {
  try { socket?.close() } catch { /* already gone */ }
  chrome.kill('SIGTERM')
}

if (failures.length) {
  console.error(`\n${failures.length} boot check(s) failed`)
  process.exit(1)
}
console.log('\nboot smoke passed')
