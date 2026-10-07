'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { toOpenAIError } = require('../../utils/errors')

test('a Claude 403 account_session_invalid tells the client to re-capture the login', () => {
  const error = new Error(
    JSON.stringify({
      type: 'error',
      error: { type: 'permission_error', message: 'Invalid authorization' },
    }),
  )
  error.status = 403
  const out = toOpenAIError(error, 'claude').error
  assert.equal(out.category, 'session_expired')
  assert.equal(out.status, 401)
  assert.match(out.action, /Re-capture/)
  assert.match(out.action, /claude\.ai/)
})
