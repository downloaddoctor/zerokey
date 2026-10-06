'use strict'

// The append-only prefix ledger.
//
// Prefixes are a compatibility contract with every IDE build already in the
// wild: a user on an old VS Code / OpenCode / Terax still ships the old system
// prompt, and ZeroKey must keep recognising it. That means a prefix that has
// shipped may never be deleted, only appended to.
//
// This test enforces the contract in both directions:
//
//   1. Every prefix frozen in prefixes.snapshot.json is still declared by its
//      surface. Fails when someone removes one.
//   2. Every prefix declared by a surface is frozen in the snapshot. Fails
//      when someone adds a new one — the developer must add it to the
//      snapshot in the same commit so it too is protected from now on.
//   3. Every surface in the snapshot still exists in the registry. Fails if
//      a surface is dropped, which would send old clients to the openai
//      fallback silently.
//
// To add a prefix: declare it in surfaces/<name>/index.js and append it to
// prefixes.snapshot.json. To remove one: only if the provider has publicly
// dropped that prompt version, and say so in the commit message.

const assert = require('node:assert')
const test = require('node:test')

const registry = require('../../surfaces/registry')
const snapshot = require('./prefixes.snapshot.json')

function declaredReal(surface) {
  const out = []
  if (typeof surface.realSessionPrefix === 'string' && surface.realSessionPrefix) {
    out.push(surface.realSessionPrefix)
  }
  if (Array.isArray(surface.realSessionPrefixAliases)) {
    out.push(...surface.realSessionPrefixAliases)
  }
  return out
}

function declaredUtility(surface) {
  return Array.isArray(surface.utilityPrefixes) ? [...surface.utilityPrefixes] : []
}

test('every frozen prefix is still declared', () => {
  for (const [name, frozen] of Object.entries(snapshot)) {
    const surface = registry.getSurface(name)
    assert.ok(surface, 'surface "' + name + '" is missing from the registry')

    const real = declaredReal(surface)
    const utility = declaredUtility(surface)

    for (const prefix of frozen.real || []) {
      assert.ok(
        real.includes(prefix),
        'surface "' +
          name +
          '" no longer declares real prefix ' +
          JSON.stringify(prefix) +
          ' — old clients still send it; never remove a shipped prefix',
      )
    }
    for (const prefix of frozen.utility || []) {
      assert.ok(
        utility.includes(prefix),
        'surface "' +
          name +
          '" no longer declares utility prefix ' +
          JSON.stringify(prefix) +
          ' — never remove a shipped prefix',
      )
    }
  }
})

test('every declared prefix is frozen in the snapshot', () => {
  for (const name of registry.getNames()) {
    const surface = registry.getSurface(name)
    assert.ok(surface, 'surface "' + name + '" is missing from the registry')

    const frozen = snapshot[name]
    assert.ok(
      frozen,
      'surface "' +
        name +
        '" is not in test/surfaces/prefixes.snapshot.json — add it and freeze its prefixes',
    )

    const frozenReal = new Set(frozen.real || [])
    const frozenUtility = new Set(frozen.utility || [])

    for (const prefix of declaredReal(surface)) {
      assert.ok(
        frozenReal.has(prefix),
        'new real prefix on "' +
          name +
          '" is not frozen: ' +
          JSON.stringify(prefix) +
          ' — append it to test/surfaces/prefixes.snapshot.json',
      )
    }
    for (const prefix of declaredUtility(surface)) {
      assert.ok(
        frozenUtility.has(prefix),
        'new utility prefix on "' +
          name +
          '" is not frozen: ' +
          JSON.stringify(prefix) +
          ' — append it to test/surfaces/prefixes.snapshot.json',
      )
    }
  }
})

test('every frozen surface is still registered', () => {
  const names = new Set(registry.getNames())
  for (const name of Object.keys(snapshot)) {
    assert.ok(
      names.has(name),
      'frozen surface "' +
        name +
        '" is no longer registered — old clients would fall back silently',
    )
  }
})
