'use strict'

/**
 * Claude transport selection.
 *
 * CONFIG.CLAUDE_TRANSPORT ('completion' default, 'rpc' opt-in) is the global
 * choice, resolved once at require-time. Legacy captures (org id in the URL
 * path) can only speak REST SSE, so resolveTransport(parsedFetch) forces
 * 'completion' for them. RPC-shaped captures may use either transport.
 *
 * Lives in its own module so both index.js and router.js can use it without a
 * circular require.
 */

const { CONFIG } = require('../../config/constants')
const { ClaudeAPI } = require('./api')
const { ClaudeConnectRpc } = require('./connect-rpc')

const completion = CONFIG.CLAUDE_TRANSPORT === 'completion'

/** Resolved-once transport flags. Read these directly, like CONFIG. */
const TRANSPORT = Object.freeze({
  name: completion ? 'completion' : 'rpc',
  IS_RPC: !completion,
  IS_COMPLETION: completion,
})

const RPC = Object.freeze({ name: 'rpc', IS_RPC: true, IS_COMPLETION: false })
const COMPLETION = Object.freeze({ name: 'completion', IS_RPC: false, IS_COMPLETION: true })

/**
 * Per-capture transport. Legacy captures (org id in the URL path, no RPC URL)
 * can only speak REST SSE, so they always get 'completion'. RPC-shaped captures
 * get the configured transport (completion by default), so new users can use
 * either one.
 */
function resolveTransport(parsedFetch) {
  const req = (parsedFetch && parsedFetch.request) || {}
  const url = String((parsedFetch && parsedFetch.url) || req.url || '')
  const legacy = !/\/claudeai-rpc\//i.test(url) && /\/organizations\/[a-f0-9-]{36}/i.test(url)
  if (legacy) return COMPLETION
  // RPC is broken (f15 device signature); completion serves old and new captures.
  return CONFIG.CLAUDE_TRANSPORT === 'rpc' ? RPC : COMPLETION
}

/** The API client for the capture's transport (global transport if no capture). */
function createAPI(options = {}, parsedFetch = null) {
  const t = parsedFetch ? resolveTransport(parsedFetch) : TRANSPORT
  return t.IS_COMPLETION ? new ClaudeAPI(options) : new ClaudeConnectRpc(options)
}

module.exports = { TRANSPORT, resolveTransport, createAPI }
