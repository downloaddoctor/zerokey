'use strict'

const fs = require('fs')
const path = require('path')
const { CONFIG } = require('../config/constants')

const NL = String.fromCharCode(10)
const KEEP_MS = 24 * 60 * 60 * 1000

function truncatePrompt(prompt, limit) {
  const approxDropped = prompt.length - (limit - 64)
  const marker =
    NL +
    NL +
    '[TRUNCATED: final prompt exceeded the provider prompt limit. ≈ ' +
    approxDropped +
    ' chars dropped]'
  const text = (prompt.slice(0, Math.max(0, limit - marker.length)) + marker).slice(0, limit)
  return { text, spilled: 0, dropped: prompt.length - text.length, parts: 0, dir: null }
}

function buildNote(file, chars) {
  return '[TRUNCATED: ' + chars + ' chars left, read them from ' + file + ']'
}

function cleanOld(root) {
  try {
    const now = Date.now()
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name)
      if (now - fs.statSync(full).mtimeMs > KEEP_MS)
        fs.rmSync(full, { recursive: true, force: true })
    }
  } catch {
    // best effort
  }
}

/**
 * Keep the head of the prompt inline (cut on a line break), write the leftover
 * to one file <dataDir>/overflow/<id>/prompt.txt and start the text with a note. Returns null if the files cannot
 * be written or the note itself would not fit (fitPrompt falls back to truncation).
 */
function spillOverflow(prompt, limit, dataDir) {
  const root = path.join(dataDir, 'overflow')
  const dir = path.join(root, Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const file = path.join(dir, 'prompt.txt')
  // Head stays inline, cut on a line boundary; only the leftover goes to the file. The budget uses the full length (most digits), so the final note always fits.
  const budget = limit - buildNote(file, prompt.length).length - 2
  if (budget < 1) return null
  let cut = budget
  const nl = prompt.lastIndexOf(NL, budget - 1)
  if (nl >= budget / 2) cut = nl + 1
  const rest = prompt.slice(cut)
  const text = buildNote(file, rest.length) + NL + NL + prompt.slice(0, cut)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, rest, 'utf8')
  } catch {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    return null
  }
  cleanOld(root)
  return { text, spilled: rest.length, parts: 1, dir }
}

/**
 * Fit a prompt into the provider limit. Under the limit: returned as is.
 * Over: the whole prompt goes to one prompt.txt file (see spillOverflow), hard
 * truncation only if it cannot be written.
 * Returns { text, spilled, dropped, parts, dir }; always fits the limit.
 */
function fitPrompt(prompt, limit, dataDir) {
  if (prompt.length <= limit) {
    return { text: prompt, spilled: 0, dropped: 0, parts: 0, dir: null }
  }
  const spill = spillOverflow(prompt, limit, dataDir)
  if (!spill) return truncatePrompt(prompt, limit)
  return {
    text: spill.text,
    spilled: spill.spilled,
    dropped: 0,
    parts: spill.parts,
    dir: spill.dir,
  }
}

/**
 * Full prompt limiter. `compiler` supplies the limit and receives lastPrompt
 * (usage reporting, see engine/usage.js). Returns the prompt to send.
 */
function limitPrompt(compiler, prompt) {
  const limit = compiler._promptLimit

  if (prompt.length <= limit) {
    console.debug('[PROMPT] FINAL', {
      chars: prompt.length,
      bytes: Buffer.byteLength(prompt, 'utf8'),
      limit,
      truncated: false,
    })
    compiler.lastPrompt = {
      chars: prompt.length,
      limit,
      headroom: limit - prompt.length,
      dropped: 0,
      truncated: false,
    }
    return prompt
  }

  console.warn(`[PROMPT] Final prompt exceeded ${limit} chars: ${prompt.length}`)
  const fit = fitPrompt(prompt, limit, CONFIG.DATA_DIR)
  if (fit.parts)
    console.info('[PROMPT] overflow written to files', { parts: fit.parts, dir: fit.dir })

  console.debug('[PROMPT] FINAL', {
    chars: fit.text.length,
    bytes: Buffer.byteLength(fit.text, 'utf8'),
    limit,
    truncated: true,
    dropped: fit.dropped,
  })
  compiler.lastPrompt = {
    chars: fit.text.length,
    limit,
    headroom: 0,
    spilled: fit.spilled,
    dropped: fit.dropped,
    truncated: true,
  }
  return fit.text
}

module.exports = { limitPrompt }
