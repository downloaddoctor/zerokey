'use strict'

/**
 * Drift watcher for upstream prompt prefixes.
 *
 * ZeroKey recognises IDE prompts by prefix (see surfaces/*\/index.js and
 * test/surfaces/prefixes.snapshot.json). Those prefixes are frozen — old
 * clients keep sending them forever, so we must never delete one.
 *
 * The other half of that contract is knowing when upstream *adds* or *renames*
 * a prefix. This script fetches the source file behind each watched prefix and
 * reports:
 *
 *   OK    the declared prefix still appears verbatim in the source
 *   DRIFT the source no longer contains the prefix — it was renamed or moved
 *   ERR   the source could not be fetched (404, network) — it moved
 *
 * Exit code is 1 on any DRIFT or ERR, 0 when everything is in place.
 *
 * Deliberately NOT part of `pnpm test`: it hits the network and would make the
 * normal test run fail on a plane, in a locked-down CI, or on a GitHub outage.
 * Run it manually or from a scheduled workflow.
 *
 *   node scripts/check-prefix-drift.js
 *   pnpm check:prefixes
 *
 * When it reports drift, do not auto-edit. Read the file, then:
 *   1. append the new prefix to surfaces/<name>/index.js
 *   2. append the same string to test/surfaces/prefixes.snapshot.json
 *   3. keep the old prefix in both places
 */

const fs = require('fs')
const path = require('path')

const SOURCES_FILE = path.join(__dirname, '..', 'prefixes.sources.json')
const TIMEOUT_MS = 15000
const EXCERPT_MAX = 200

async function fetchText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull a plausible candidate prefix out of the fetched source so the report
 * shows the reviewer what the new prompt looks like. Heuristic: the first line
 * (skipping license / line comments) that reads like a system prompt.
 */
function extractExcerpt(text) {
  if (typeof text !== 'string') return null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue
    if (/^(You are|You're|Summarize|You are a title|You are a context)\b/.test(line)) {
      return line.length > EXCERPT_MAX ? line.slice(0, EXCERPT_MAX) + '…' : line
    }
  }
  return null
}

async function checkOne(entry) {
  const text = await fetchText(entry.url)
  if (text.includes(entry.declared)) return { ok: true }
  return { ok: false, excerpt: extractExcerpt(text) }
}

function label(entry) {
  return entry.surface + '/' + entry.kind + '  ' + JSON.stringify(entry.declared)
}

async function main() {
  let sources
  try {
    sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'))
  } catch (error) {
    console.error('Cannot read ' + SOURCES_FILE + ': ' + (error.message || error))
    process.exit(1)
  }

  const watch = Array.isArray(sources.watch) ? sources.watch : []
  const unwatched = Array.isArray(sources.unwatched) ? sources.unwatched : []

  let failures = 0
  for (const entry of watch) {
    try {
      const result = await checkOne(entry)
      if (result.ok) {
        console.log('OK    ' + label(entry))
      } else {
        failures++
        console.log('DRIFT ' + label(entry))
        console.log('      url: ' + entry.url)
        console.log('      now: ' + (result.excerpt || '(no candidate line found)'))
      }
    } catch (error) {
      failures++
      console.log('ERR   ' + label(entry))
      console.log('      url: ' + entry.url)
      console.log('      err: ' + (error && error.message ? error.message : String(error)))
    }
  }

  for (const entry of unwatched) {
    console.log('SKIP  ' + label(entry) + '  (' + entry.reason + ')')
  }

  if (failures > 0) {
    console.log(
      '\n' +
        failures +
        ' drift/failure(s). Upstream may have changed a prefix. Re-read each URL,' +
        ' append the new prefix to surfaces/<name>/index.js AND' +
        ' test/surfaces/prefixes.snapshot.json, and keep the old one.',
    )
    process.exit(1)
  }

  console.log('\nNo drift. ' + watch.length + ' watched, ' + unwatched.length + ' unwatched.')
}

// Only run when invoked directly. scripts/check-modules.js requires every
// scripts/*.js to prove it loads; without this guard the network fetch would
// fire inside `pnpm check` and break the offline contract.
if (require.main === module) {
  main().catch((error) => {
    console.error('check-prefix-drift crashed: ' + (error && error.stack ? error.stack : error))
    process.exit(1)
  })
}

module.exports = { checkOne, extractExcerpt, main }
