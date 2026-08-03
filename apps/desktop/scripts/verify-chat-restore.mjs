/**
 * End-to-end check for conversation persistence and the reload path.
 *
 * ## What this proves that a unit test cannot
 *
 * The unit tests exercise `EndpointManager` directly. Everything between it and
 * the screen — the delta fan-out, the IPC channel, preload's bridge, the
 * renderer's mirror, the effect in `ChatView` that asks for a re-send — is
 * mocked out or absent there. That gap is exactly where the reported bug lived:
 * every piece worked, and nothing connected them.
 *
 * So this drives the real built app over CDP and checks the four things a person
 * would check:
 *
 *   1. a conversation appears on screen, **including the user's own message**;
 *   2. reloading the renderer (`⌘R`) brings the whole thing back;
 *   3. closing the tab and reopening from the sessions rail brings it back, and
 *      the model still remembers it;
 *   4. restarting the app entirely leaves the conversation in the catalogue.
 *
 * ## Costs nothing and touches nothing
 *
 * The model is a local stub speaking OpenAI's streaming completions shape, so
 * no tokens and no network. `PEEK_CONFIG_DIR` and `--user-data-dir` are both
 * throwaway directories: the user's own `~/.peek`, their conversations and their
 * keychain are never opened. It exercises the **endpoint** backend because that
 * is the one peek stores itself; the ACP backend's half of the reload path is
 * covered by `manager.test.ts`'s `reloadChat` tests, which can use the stub
 * agent and need no login.
 *
 * Usage: `node scripts/verify-chat-restore.mjs [--verbose]`
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const VERBOSE = process.argv.includes('--verbose')
const APP_LIFETIME_MS = 180_000
const CDP_READY_TIMEOUT_MS = 45_000

const FIRST_ANSWER = 'There are four tables.'
const SECOND_ANSWER = 'You asked how many tables there are.'

function log(...args) {
  console.log(...args)
}
function debug(...args) {
  if (VERBOSE) console.log(...args)
}

/* ------------------------------------------------------------------ */
/* The stub model                                                      */
/* ------------------------------------------------------------------ */

/**
 * An OpenAI-completions endpoint that streams a canned answer.
 *
 * It also records the prompts it is given, which is what makes step 3's second
 * half checkable: "the model still remembers" is only true if the *history*
 * comes back up the wire, and that is visible here and nowhere else.
 */
function startStubModel() {
  const prompts = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        /* leave empty */
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      prompts.push(messages)
      debug(`[stub-model] ${String(messages.length)} messages in`)

      const answer = messages.length > 2 ? SECOND_ANSWER : FIRST_ANSWER
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const id = 'chatcmpl-stub'
      const chunk = (delta) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'stub-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      res.write(chunk({ role: 'assistant', content: '' }))
      for (const piece of answer.match(/.{1,6}/gu) ?? []) res.write(chunk({ content: piece }))
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'stub-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, prompts })
    })
  })
}

/* ------------------------------------------------------------------ */
/* The app                                                             */
/* ------------------------------------------------------------------ */

function electronBinaryPath() {
  const require = createRequire(import.meta.url)
  return require(require.resolve('electron', { paths: [DESKTOP_DIR] }))
}

/**
 * Settings for the stub endpoint — deliberately **without an API key**.
 *
 * This used to seal a dummy key through a second Electron process, because
 * `pi-ai` refused to build a request with neither a key nor an auth header and
 * peek passed neither. That was `2026-08-03-chat-history-ownership.md` §6.3's
 * first bug: the keyless local endpoint this backend exists for could not send.
 * `provider.ts` now resolves a sentinel `authorization` header instead, so the
 * scaffolding is gone and this script covers the keyless path by being it — if
 * it runs at all, a keyless endpoint can send.
 */
function writeSettings(configDir, modelPort) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify(
      {
        agent: {
          backend: 'endpoint',
          permissionMode: 'default',
          endpoint: {
            baseUrl: `http://127.0.0.1:${String(modelPort)}/v1`,
            model: 'stub-model',
            api: 'openai-completions',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )
}

function launchApp({ configDir, userDataDir, cdpPort }) {
  const env = { ...process.env }
  // Inherited from whatever spawned this script, it would turn the Electron
  // binary into a bare node runtime: no window, nothing to drive.
  delete env['ELECTRON_RUN_AS_NODE']
  env['PEEK_CONFIG_DIR'] = configDir
  env['PEEK_SMOKE_EXIT_MS'] = String(APP_LIFETIME_MS)
  const child = spawn(
    electronBinaryPath(),
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${String(cdpPort)}`],
    { cwd: DESKTOP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const [stream, tag] of [
    [child.stdout, 'out'],
    [child.stderr, 'err'],
  ]) {
    stream.setEncoding('utf8')
    stream.on('data', (piece) => {
      for (const line of piece.split('\n')) if (line.trim()) debug(`[app/${tag}] ${line}`)
    })
  }
  return child
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

async function connectCdp(port) {
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return await openSocket(page.webSocketDebuggerUrl)
    } catch {
      /* not listening yet */
    }
    await delay(250)
  }
  throw new Error('the renderer never exposed a CDP target')
}

async function openSocket(url) {
  // Node's own `WebSocket`, as `verify-auto-refresh.mjs` uses: no dependency for
  // a script whose whole job is checking a shipped build.
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error(`CDP socket failed: ${url}`)), { once: true })
  })
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message))
    else entry.resolve(msg.result)
  })
  return {
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close() {
      socket.close()
    },
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate threw')
  }
  return result.result.value
}

/** Poll `expression` until it is truthy. Returns the value. */
async function until(cdp, expression, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression)
    if (last) return last
    await delay(200)
  }
  throw new Error(`timed out waiting for ${what} (last value: ${JSON.stringify(last)})`)
}

/* ------------------------------------------------------------------ */
/* The page-side helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything below reads the DOM the user sees rather than any internal store.
 * A transcript that is in the mirror but not on screen is not a restored
 * conversation, and this bug was in that gap once already.
 */
const READ_TRANSCRIPT = `
  Array.from(document.querySelectorAll('.chat-msg'))
    .map((n) => (n.classList.contains('user') ? 'user' : 'agent') + ':' + (n.innerText || '').trim().replace(/\\s+/g, ' '))
`

/**
 * The transcript, once nothing is still being written.
 *
 * Reading it the moment a second message exists catches the answer mid-stream —
 * the assertion then fails on a partial sentence that was on its way to being
 * right, which is a flake rather than a finding.
 */
const SETTLED_TRANSCRIPT = (least) => `
  (() => {
    if (document.querySelector('.chat-msg.streaming')) return null
    const m = ${READ_TRANSCRIPT}
    return m.length >= ${String(least)} ? m : null
  })()
`

const CLICK_NEW_CHAT = `
  (() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((b) => /new conversation|新建对话/i.test(b.getAttribute('title') || b.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })()
`

const OPEN_RAIL = `
  (() => {
    if (document.querySelector('.chat-rail .session-list')) return true
    const b = Array.from(document.querySelectorAll('button'))
      .find((n) => /show or hide the conversation list|显示或隐藏/i.test(n.getAttribute('title') || ''))
    if (!b) return false
    b.click()
    return true
  })()
`

const READ_ROWS = `
  (() => {
    const rows = Array.from(document.querySelectorAll('.session-item'))
    return rows.length > 0 ? rows.map((r) => (r.innerText || '').trim().replace(/\\s+/g, ' ')) : null
  })()
`

const sendMessage = (text) => `
  (() => {
    const box = document.querySelector('.chat-view textarea')
    if (!box) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, ${JSON.stringify(text)})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()
`

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

function assert(condition, message, detail) {
  if (condition) {
    log(`  ✓ ${message}`)
    return
  }
  throw new Error(`${message}\n    ${detail ?? ''}`)
}

async function main() {
  const model = await startStubModel()
  const configDir = mkdtempSync(join(tmpdir(), 'peek-restore-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-restore-udd-'))
  const cdpPort = 9333 + Math.floor(Math.random() * 400)
  writeSettings(configDir, model.port)
  log(`stub model on :${String(model.port)}, config in ${configDir}`)

  let app = launchApp({ configDir, userDataDir, cdpPort })
  let cdp = await connectCdp(cdpPort)

  try {
    /* ---- 1. a conversation, with both sides of it on screen ---- */
    log('\n1. a conversation appears, including the user’s own message')
    await until(cdp, `!!document.querySelector('.status-bar, .statusbar, footer')`, 'the window to render')
    await until(cdp, CLICK_NEW_CHAT, 'the "new conversation" button')
    await until(cdp, `!!document.querySelector('.chat-view textarea')`, 'the composer')
    await until(cdp, sendMessage('how many tables?'), 'the message to be sent')

    const first = await until(cdp, SETTLED_TRANSCRIPT(2), 'both messages to land')
    assert(
      first.some((m) => m.startsWith('user:') && m.includes('how many tables?')),
      'the user’s own message is in the transcript',
      `got ${JSON.stringify(first)}`,
    )
    assert(
      first.some((m) => m.startsWith('agent:') && m.includes(FIRST_ANSWER)),
      'the answer is in the transcript',
      `got ${JSON.stringify(first)}`,
    )

    /* ---- 2. the reported bug: reload the renderer ---- */
    log('\n2. reloading the renderer brings the conversation back')
    await cdp.send('Page.enable')
    await cdp.send('Page.reload', { ignoreCache: false })
    cdp.close()
    await delay(1_500)
    cdp = await connectCdp(cdpPort)
    await until(cdp, `!!document.querySelector('.chat-view')`, 'the chat view after reload')

    const afterReload = await until(cdp, SETTLED_TRANSCRIPT(2), 'the transcript to be restored after a reload')
    assert(
      afterReload.some((m) => m.startsWith('user:') && m.includes('how many tables?'))
        && afterReload.some((m) => m.includes(FIRST_ANSWER)),
      'both messages survive ⌘R',
      `got ${JSON.stringify(afterReload)}`,
    )

    /* ---- 3. close the tab, reopen from the rail, and check memory ---- */
    log('\n3. closing the tab is a detach, not a delete')
    await until(
      cdp,
      `(() => {
        const x = document.querySelector('.panel-tabs .tab-close')
        if (!x) return false
        x.click()
        return true
      })()`,
      'the chat tab to close',
    )
    await until(cdp, `!document.querySelector('.chat-msg')`, 'the chat view to go away')

    await until(cdp, OPEN_RAIL, 'the conversations rail to open')
    const row = await until(cdp, READ_ROWS, 'the conversation to be listed')
    assert(
      row.some((r) => r.includes('how many tables?')),
      'the conversation is in the catalogue, named by its first message',
      `got ${JSON.stringify(row)}`,
    )

    await until(
      cdp,
      `(() => {
        const r = document.querySelector('.session-item')
        if (!r) return false
        r.click()
        return true
      })()`,
      'the conversation to be reopened',
    )
    const reopened = await until(cdp, SETTLED_TRANSCRIPT(2), 'the reopened transcript')
    assert(
      reopened.some((m) => m.includes('how many tables?')) && reopened.some((m) => m.includes(FIRST_ANSWER)),
      'a reopened conversation shows its history',
      `got ${JSON.stringify(reopened)}`,
    )

    const before = model.prompts.length
    await until(cdp, sendMessage('what did I ask?'), 'a follow-up message')
    await until(cdp, SETTLED_TRANSCRIPT(4), 'the follow-up answer')
    const lastPrompt = model.prompts[model.prompts.length - 1] ?? []
    // `content` is a string on some shapes and an array of parts on others, so
    // the check flattens rather than assuming either.
    const flat = JSON.stringify(lastPrompt)
    assert(
      model.prompts.length > before && flat.includes('how many tables?'),
      'the model gets the earlier turn too — the memory came back, not just the screen',
      `last prompt had ${String(lastPrompt.length)} messages: ${JSON.stringify(lastPrompt.map((m) => m.role))}`,
    )

    /* ---- 4. a full restart ---- */
    log('\n4. the conversation survives a restart of the whole app')
    cdp.close()
    app.kill()
    await delay(1_500)
    app = launchApp({ configDir, userDataDir, cdpPort })
    cdp = await connectCdp(cdpPort)
    await until(cdp, `!!document.querySelector('.status-bar, .statusbar, footer')`, 'the window after restart')
    await until(cdp, OPEN_RAIL, 'the conversations rail after restart')
    const afterRestart = await until(cdp, READ_ROWS, 'the catalogue after restart')
    assert(
      afterRestart.some((r) => r.includes('how many tables?')),
      'the conversation is still in the catalogue after a restart',
      `got ${JSON.stringify(afterRestart)}`,
    )

    log('\nall four checks passed.')
  } finally {
    try {
      cdp.close()
    } catch {
      /* already closed */
    }
    app.kill()
    model.server.close()
    rmSync(configDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
})
