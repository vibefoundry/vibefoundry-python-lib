// What the IDE has been doing, kept in memory so the Logs button has something
// to show.
//
// This exists because the pane runs inside a sandboxed iframe in a desktop app:
// there is no devtools console to open, no network tab, and no server log
// anyone sees. When the UI misbehaves the only evidence available is whatever
// the UI itself bothered to write down. So it writes things down.
//
// It is a ring buffer and nothing else — no upload, no persistence, no network.
// The contents leave this machine only if someone presses Copy and pastes them.

const LIMIT = 400
const events = []
const startedAt = Date.now()

/** Trim anything that could make one entry dominate the buffer. */
function clip(value, max = 300) {
  if (value == null) return value
  const s = typeof value === 'string' ? value : String(value)
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s
}

export function record(event, detail) {
  events.push({ at: Date.now() - startedAt, event, ...(detail || {}) })
  if (events.length > LIMIT) events.splice(0, events.length - LIMIT)
}

export function getEvents() {
  return events.slice()
}

/**
 * Capture the errors that otherwise vanish.
 *
 * console.error is wrapped rather than replaced: the original still runs, so
 * nothing changes for anyone with a real console open.
 */
export function installErrorCapture() {
  if (typeof window === 'undefined' || window.__vfErrorCaptureInstalled) return
  window.__vfErrorCaptureInstalled = true

  const origError = console.error
  console.error = function (...args) {
    record('console.error', { message: clip(args.map(String).join(' ')) })
    return origError.apply(console, args)
  }

  const origWarn = console.warn
  console.warn = function (...args) {
    record('console.warn', { message: clip(args.map(String).join(' ')) })
    return origWarn.apply(console, args)
  }

  window.addEventListener('error', (e) => {
    record('window.error', {
      message: clip(e && e.message),
      source: clip(e && e.filename, 120),
      line: e && e.lineno,
    })
  })

  // The failure mode that produced no console output at all: a promise rejected
  // inside a relay call with nobody awaiting it.
  window.addEventListener('unhandledrejection', (e) => {
    record('unhandled.rejection', {
      message: clip((e && e.reason && (e.reason.message || e.reason)) || 'unknown'),
    })
  })
}

/**
 * A one-line summary of the environment, so a pasted log says where it came
 * from without anyone having to ask.
 */
export function environment() {
  const w = typeof window !== 'undefined' ? window : {}
  return {
    href: (w.location && w.location.href) || null,
    hasHostBridge: !!w.openai,
    displayMode: (w.openai && w.openai.displayMode) || null,
    framed: typeof window !== 'undefined' ? window.self !== window.top : null,
    userAgent: (w.navigator && w.navigator.userAgent) || null,
    uptimeMs: Date.now() - startedAt,
  }
}
