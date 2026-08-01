/**
 * Tests for error classification and, more importantly, for the two security
 * properties this module is responsible for: the MCP bearer token never reaches
 * a log or an error, and agent-authored text cannot smuggle control characters
 * into anything peek displays.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTH_HELP, classifyAcpError, isAuthFailure, isConnectionClosed, previewInput, redact, sanitizeLine } from '../errors'

const TOKEN = 'aVeryLongLookingBearerTokenValue0123456789'

test('secrets are removed wherever they appear', () => {
  const text = `GET /mcp Authorization: Bearer ${TOKEN} failed`
  const out = redact(text, [TOKEN])
  assert.ok(!out.includes(TOKEN))
  assert.ok(out.includes('***'))
})

test('a short "secret" is ignored, so an empty token cannot blank the text', () => {
  assert.equal(redact('hello world', ['', 'abc']), 'hello world')
})

test('classification redacts the token out of both message and detail', () => {
  const error = classifyAcpError(
    { code: -32603, message: `bad token ${TOKEN}`, data: { header: `Bearer ${TOKEN}` } },
    [TOKEN],
  )
  assert.ok(!JSON.stringify(error).includes(TOKEN))
})

test('control characters are stripped from displayed text', () => {
  const nasty = `normal${String.fromCharCode(27)}[2J${String.fromCharCode(7)}overwrite${String.fromCharCode(0)} end`
  const clean = sanitizeLine(nasty)
  assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(clean))
  assert.ok(clean.includes('normal'))
  assert.ok(clean.includes('end'))
})

test('sanitizeLine caps the length', () => {
  assert.ok(sanitizeLine('x'.repeat(1_000), 100).length <= 101)
})

test('previewInput bounds an unbounded argument blob', () => {
  const preview = previewInput({ rows: 'r'.repeat(10_000) }, 50)
  assert.ok(preview.length <= 51)
})

test('previewInput survives a value JSON cannot serialise', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  assert.doesNotThrow(() => previewInput(cyclic))
})

test('the auth-required code is recognised', () => {
  assert.equal(isAuthFailure({ code: -32000, message: 'Authentication required' }), true)
})

test('an authentication failure disguised as an internal error is recognised', () => {
  const raw = { code: -32603, message: 'API Error: 401 authentication_error', data: { errorKind: 'server_error' } }
  assert.equal(isAuthFailure(raw), true)
  const error = classifyAcpError(raw)
  assert.equal(error.code, 'CONNECTION_FAILED')
  assert.equal(error.detail, AUTH_HELP)
  assert.equal(error.retryable, false)
})

test('the auth guidance points at the terminal and never asks for a credential', () => {
  assert.ok(AUTH_HELP.includes('claude'))
  assert.ok(!/password|api key|token/i.test(AUTH_HELP.replace('never handles credentials itself', '')))
})

test('an ordinary internal error is not mistaken for an auth failure', () => {
  const raw = { code: -32603, message: 'API Error: Unable to connect to API (ConnectionRefused)' }
  assert.equal(isAuthFailure(raw), false)
  assert.equal(classifyAcpError(raw).code, 'INTERNAL')
})

test('a bare "ACP connection closed" is classified as a crashed agent', () => {
  const raw = new Error('ACP connection closed')
  assert.equal(isConnectionClosed(raw), true)
  const error = classifyAcpError(raw)
  assert.equal(error.code, 'DRIVER_CRASHED')
  assert.equal(error.retryable, true)
})

test('a cancelled request maps to CANCELLED', () => {
  assert.equal(classifyAcpError({ code: -32800, message: 'Request cancelled' }).code, 'CANCELLED')
})

test('invalid params map to BAD_REQUEST', () => {
  assert.equal(classifyAcpError({ code: -32602, message: 'cwd must be an absolute path' }).code, 'BAD_REQUEST')
})

test('a non-object rejection still produces a PeekError', () => {
  const error = classifyAcpError('something went wrong')
  assert.equal(error.code, 'INTERNAL')
  assert.equal(error.message, 'something went wrong')
})
