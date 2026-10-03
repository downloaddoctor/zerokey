'use strict'

/**
 * Read the OpenCode-flavoured headers ZeroKey understands. All are optional;
 * a missing header becomes null and never invents a value.
 */

const FIELDS = [
  ['session', ['x-zerokey-session', 'x-opencode-session-id']],
  ['rootSession', ['x-zerokey-root-session', 'x-opencode-root-session-id']],
  ['messageId', ['x-zerokey-message-id', 'x-opencode-message-id']],
  ['partId', ['x-zerokey-part-id', 'x-opencode-part-id']],
  ['generation', ['x-zerokey-compaction-generation', 'x-opencode-compaction-generation']],
]

function read(headers) {
  const found = {}
  for (const [name, candidates] of FIELDS) {
    let value = null
    for (const candidate of candidates) {
      const raw = headers[candidate]
      if (raw !== undefined && String(raw).trim() !== '') {
        value = String(raw).trim()
        break
      }
    }
    found[name] = value
  }

  const text = found.generation
  const generation = typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : null
  found.generation =
    generation !== null && Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
  return found
}

module.exports = { read, FIELDS }
