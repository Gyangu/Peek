import { setTimeout as delay } from 'node:timers/promises'

/**
 * The narrowest CDP client that can do the job: one WebSocket, `Runtime.evaluate`
 * with `awaitPromise`. No dependency, and nothing to keep in sync with a
 * protocol version.
 *
 * Shared by the verify/smoke scripts because they all want the same one thing —
 * to read what the *window* believes, rather than what main told it. Anything
 * asserted against main's own state would keep passing if the IPC that carries
 * it to the renderer broke.
 */
export class Cdp {
  #ws
  #next = 1
  #pending = new Map()
  /** Set once the socket is gone, so a later `send` fails saying so. */
  #gone = null

  static async attach(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
        const targets = await res.json()
        // The renderer is the only `page` target the app opens; DevTools itself
        // would show up as `other`.
        const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
        if (page) return await new Cdp().#open(page.webSocketDebuggerUrl)
      } catch (error) {
        lastError = error
      }
      await delay(250)
    }
    throw new Error(`no CDP page target on port ${String(port)}: ${String(lastError?.message ?? lastError)}`)
  }

  async #open(url) {
    this.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true })
      this.#ws.addEventListener('error', () => {
        reject(new Error(`CDP websocket failed to open: ${url}`))
      }, { once: true })
    })
    this.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      const entry = this.#pending.get(msg.id)
      if (!entry) return // an event, not a reply
      this.#pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${String(msg.error.code)})`))
      else entry.resolve(msg.result)
    })
    // A reply that can no longer arrive has to say so. Without this the app
    // exiting under a caller — its own smoke deadman switch reaching 120s, a
    // crash, a window that went away — leaves an `await` that nothing will ever
    // settle, and the run ends on Node's "unsettled top-level await" with exit
    // 13 and not one word about where it was (§4duovicies(d), the second of the
    // two flakes recorded there).
    this.#ws.addEventListener('close', () => {
      this.#abandon('the CDP connection closed — the app most likely exited')
    })
    return this
  }

  #abandon(reason) {
    this.#gone ??= reason
    const waiting = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of waiting) entry.reject(new Error(reason))
  }

  send(method, params = {}, timeoutMs = 150_000) {
    if (this.#gone !== null) return Promise.reject(new Error(`${method}: ${this.#gone}`))
    const id = this.#next++
    return new Promise((resolve, reject) => {
      // Longer than the `Runtime.evaluate` timeout below it, because it is
      // guarding a different thing: that one bounds a script that runs too long,
      // this one bounds a reply that never comes. The timer is deliberately not
      // unref'd — an unref'd one would let the process exit before firing, which
      // is the exact silence it exists to break.
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} got no reply in ${String(timeoutMs)}ms`))
      }, timeoutMs)
      const settle = (fn) => (value) => {
        clearTimeout(timer)
        fn(value)
      }
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an async expression in the page and return its resolved value. */
  async evaluate(expression, timeoutMs = 120_000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page evaluation threw: ${String(text)}`)
    }
    return result.result?.value
  }

  /**
   * Resolve once React has painted something into `#root`.
   *
   * A target answering CDP is a *document*, not a rendered app: attaching wins
   * the race often enough that every reader here would otherwise have to repeat
   * this loop, and the failure of not doing so is a null `document.body` several
   * lines into an expression that looks like it is asserting something else.
   */
  async waitForFirstPaint(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const painted = await this.evaluate(
        `!!document.getElementById('root') && document.getElementById('root').children.length > 0`,
      ).catch(() => false)
      if (painted === true) return
      await delay(250)
    }
    throw new Error('the window never rendered anything into #root')
  }

  close() {
    // Marked before the socket is torn down so that the close listener's message
    // does not accuse the app of exiting when this run is the one hanging up.
    this.#abandon('the CDP connection was closed by the run itself')
    try {
      this.#ws?.close()
    } catch {
      /* already gone */
    }
  }
}
