'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const recovery = require('../../providers/chatgpt/recovery')

test('isUnauthorized is true for 401 status', () => {
  assert.equal(recovery.isUnauthorized({ status: 401 }), true)
  assert.equal(recovery.isUnauthorized({ statusCode: 401 }), true)
  assert.equal(recovery.isUnauthorized({ status: 403 }), false)
  assert.equal(recovery.isUnauthorized(null), false)
})

test('withAuthRecovery passes through a successful call', async () => {
  const api = {}
  let calls = 0
  const result = await recovery.withAuthRecovery(api, async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

test('withAuthRecovery does not retry on a non-401 error', async () => {
  const api = {}
  let calls = 0
  await assert.rejects(
    recovery.withAuthRecovery(api, async () => {
      calls += 1
      const error = new Error('boom')
      error.status = 500
      throw error
    }),
    /boom/,
  )
  assert.equal(calls, 1)
})

test('withAuthRecovery propagates a 401 when the capture reload fails', async () => {
  const api = { _providerKey: 'chatgpt' }
  await assert.rejects(
    recovery.withAuthRecovery(api, async () => {
      const error = new Error('unauth')
      error.status = 401
      throw error
    }),
    (err) => err.status === 401,
  )
})

test('withAuthRecovery reloads from the SQLite user row on 401', async () => {
  const parsedFetch = { url: 'x', method: 'POST', headers: {}, body: '{}' }
  let initialized = false
  const api = {
    _providerKey: 'chatgpt',
    initializeFromJSON: async (capture) => {
      assert.equal(capture, parsedFetch)
      initialized = true
    },
  }
  const calls = []
  const result = await recovery.withAuthRecovery(
    api,
    async () => {
      calls.push(calls.length)
      if (calls.length === 1) {
        const error = new Error('unauth')
        error.status = 401
        throw error
      }
      return 'recovered'
    },
    { username: 'chat-user', parsedFetch },
  )
  assert.equal(result, 'recovered')
  assert.equal(initialized, true)
  assert.equal(calls.length, 2)
})

test('withAuthRecovery refuses to retry a second 401 in the same process', async () => {
  const api = {
    _providerKey: 'chatgpt',
    [recovery.ONE_SHOT_401]: true,
    initializeFromJSON: async () => {},
  }
  let calls = 0
  await assert.rejects(
    recovery.withAuthRecovery(
      api,
      async () => {
        calls += 1
        const error = new Error('unauth')
        error.status = 401
        throw error
      },
      { username: 'u', parsedFetch: {} },
    ),
    (err) => err.code === 'chatgpt_401_after_recovery' || err.status === 401,
  )
  assert.equal(calls, 1)
})

test('wrap exposes the same surface', async () => {
  const api = {}
  const wrapper = recovery.wrap(api)
  assert.equal(typeof wrapper.withAuthRecovery, 'function')
  assert.equal(typeof wrapper.refreshSentinelSafe, 'function')
  assert.equal(typeof wrapper.forceReloadCapture, 'function')
})

test('refreshSentinelSafe swallows failures and reports them', async () => {
  const api = {
    _refreshSentinel: async () => {
      throw new Error('sentinel down')
    },
  }
  const result = await recovery.refreshSentinelSafe(api)
  assert.equal(result.ok, false)
  assert.match(result.reason, /sentinel down/)
})

test('refreshSentinelSafe reports ok on success', async () => {
  const api = { _refreshSentinel: async () => {} }
  const result = await recovery.refreshSentinelSafe(api)
  assert.equal(result.ok, true)
})

test('refreshSentinelSafe tolerates a missing refresh method', async () => {
  const result = await recovery.refreshSentinelSafe({})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no_refresh_method')
})
