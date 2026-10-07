'use strict'

/**
 * Token reporting. Real provider numbers win; estimate is the fallback.
 *
 * Two layers:
 *
 *   - normalization: any upstream key spelling collapses to
 *     { promptTokens, completionTokens, totalTokens } | null
 *   - reporting: buildUsage() returns the OpenAI-shaped triple plus a
 *     `source` tag — `upstream`, `mixed`, or `estimated` — so a client can
 *     decide whether to trust the numbers or fall back to context-window
 *     heuristics of its own.
 *
 * The session-total accumulator (accumulate / sessionTotals) counts only
 * estimated turns. Providers that send real numbers already tell the client
 * the truth per turn; summing context-window numbers across turns would be
 * misleading.
 */

const CHARS_PER_TOKEN = 4

const PROMPT_KEYS = [
  'prompt_tokens',
  'input_tokens',
  'prompt_token_count',
  'input_token_count',
  'promptTokens',
  'inputTokens',
]
const COMPLETION_KEYS = [
  'completion_tokens',
  'output_tokens',
  'completion_token_count',
  'output_token_count',
  'completionTokens',
  'outputTokens',
]
const TOTAL_KEYS = ['total_tokens', 'total_token_count', 'totalTokens']

function nonNegativeInteger(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  return null
}

function firstValue(object, keys) {
  if (!object || typeof object !== 'object') return null
  for (const key of keys) {
    const value = nonNegativeInteger(object[key])
    if (value !== null) return value
  }
  return null
}

/**
 * Collapse any supported spelling of upstream usage into a canonical triple.
 * Missing fields are recovered when possible:
 *   - total present, one side present → derive the other
 *   - both sides present               → total is recomputed (upstream totals lie)
 *
 * @returns {{ promptTokens: number|null, completionTokens: number|null, totalTokens: number|null }|null}
 */
function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null

  let promptTokens = firstValue(value, PROMPT_KEYS)
  let completionTokens = firstValue(value, COMPLETION_KEYS)
  let totalTokens = firstValue(value, TOTAL_KEYS)

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null
  }

  if (
    totalTokens !== null &&
    promptTokens !== null &&
    completionTokens === null &&
    totalTokens >= promptTokens
  ) {
    completionTokens = totalTokens - promptTokens
  }
  if (
    totalTokens !== null &&
    completionTokens !== null &&
    promptTokens === null &&
    totalTokens >= completionTokens
  ) {
    promptTokens = totalTokens - completionTokens
  }
  if (promptTokens !== null && completionTokens !== null) {
    totalTokens = promptTokens + completionTokens
  }

  return { promptTokens, completionTokens, totalTokens }
}

/**
 * Successive SSE events can each carry a piece of the usage picture. Taking
 * the maximum per field is the safe join: a provider that sends prompt on
 * event 1 and completion on event 2 yields the full triple, and a provider
 * that re-sends the same numbers twice yields the same triple.
 */
function mergeUsage(current, next) {
  const left = normalizeUsage(current)
  const right = normalizeUsage(next)
  if (left === null) return right
  if (right === null) return left

  const maximum = (a, b) => {
    if (a === null) return b
    if (b === null) return a
    return Math.max(a, b)
  }
  return normalizeUsage({
    promptTokens: maximum(left.promptTokens, right.promptTokens),
    completionTokens: maximum(left.completionTokens, right.completionTokens),
    totalTokens: maximum(left.totalTokens, right.totalTokens),
  })
}

/**
 * Extract usage from any of the shapes an SSE event uses in the wild. The
 * candidate list is ordered most-specific first; each candidate is merged, so
 * an event with usage in two places still lands on one triple.
 */
function usageOfEvent(event) {
  if (!event || typeof event !== 'object') return null

  const candidates = [
    event.usage,
    event.token_usage,
    event.response && event.response.usage,
    event.metadata && event.metadata.usage,
    event.message && event.message.metadata && event.message.metadata.usage,
    event.v && event.v.usage,
    event.v && event.v.message && event.v.message.metadata && event.v.message.metadata.usage,
  ]

  if (
    event.type === 'usage' ||
    event.type === 'token_usage' ||
    event.type === 'response.completed'
  ) {
    candidates.push(event)
  }

  let found = null
  for (const candidate of candidates) {
    found = mergeUsage(found, candidate)
  }
  return found
}

function estimateTokens(text) {
  const bytes = Buffer.byteLength(String(text || ''), 'utf8')
  return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / CHARS_PER_TOKEN))
}

function splitKnownTotal(totalTokens, promptEstimate, completionEstimate) {
  if (totalTokens === 0) return { promptTokens: 0, completionTokens: 0 }
  const estimateTotal = promptEstimate + completionEstimate
  if (estimateTotal === 0) return { promptTokens: totalTokens, completionTokens: 0 }
  const promptTokens = Math.min(
    totalTokens,
    Math.round((totalTokens * promptEstimate) / estimateTotal),
  )
  return { promptTokens, completionTokens: totalTokens - promptTokens }
}

/**
 * Real usage if present, else a chars/4 estimate (prose approximation).
 *
 * @param {object|undefined} realUsage  parser.tokenUsage from the stream handler
 * @param {{chars: number, limit?: number, headroom?: number, dropped?: number}|undefined} promptInfo
 * @param {number} modelChars  characters the upstream produced
 * @param {string} [promptText]  raw prompt text for the estimate path
 * @param {string} [completionText]
 */
function buildUsage(realUsage, promptInfo, modelChars, promptText, completionText) {
  const normalized = normalizeUsage(realUsage)
  const promptEstimate = promptText !== undefined ? estimateTokens(promptText) : null
  const completionEstimate = completionText !== undefined ? estimateTokens(completionText) : null

  // Real, complete numbers.
  if (
    normalized !== null &&
    normalized.promptTokens !== null &&
    normalized.completionTokens !== null &&
    (normalized.promptTokens > 0 || normalized.completionTokens > 0)
  ) {
    return {
      prompt_tokens: normalized.promptTokens,
      completion_tokens: normalized.completionTokens,
      total_tokens: normalized.totalTokens,
      source: 'upstream',
    }
  }

  // Partial real numbers: fill the missing side from the estimate.
  if (normalized !== null) {
    const promptChars = promptInfo && typeof promptInfo.chars === 'number' ? promptInfo.chars : 0
    const fallbackPrompt = Math.round(promptChars / CHARS_PER_TOKEN)
    const fallbackCompletion = Math.round((modelChars || 0) / CHARS_PER_TOKEN)

    let promptTokens = normalized.promptTokens
    let completionTokens = normalized.completionTokens

    if (promptTokens === null && completionTokens === null && normalized.totalTokens !== null) {
      const split = splitKnownTotal(
        normalized.totalTokens,
        promptEstimate ?? fallbackPrompt,
        completionEstimate ?? fallbackCompletion,
      )
      promptTokens = split.promptTokens
      completionTokens = split.completionTokens
    }
    if (promptTokens === null) promptTokens = promptEstimate ?? fallbackPrompt
    if (completionTokens === null) completionTokens = completionEstimate ?? fallbackCompletion

    const hasRealPrompt = normalized.promptTokens !== null
    const hasRealCompletion = normalized.completionTokens !== null

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      source: hasRealPrompt && hasRealCompletion ? 'upstream' : 'mixed',
      prompt_chars: promptInfo?.chars ?? null,
      prompt_chars_limit: promptInfo?.limit ?? null,
      prompt_chars_headroom: promptInfo?.headroom ?? null,
      prompt_chars_dropped: promptInfo?.dropped ?? 0,
    }
  }

  // Nothing real: estimate from characters.
  const promptChars = promptInfo && typeof promptInfo.chars === 'number' ? promptInfo.chars : 0
  const promptTokens = Math.round(promptChars / CHARS_PER_TOKEN)
  const completionTokens = Math.round((modelChars || 0) / CHARS_PER_TOKEN)

  console.debug('[USAGE] estimate', {
    modelChars,
    promptChars,
    realUsage,
  })

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    source: 'estimated',
    estimated: true,
    prompt_chars: promptChars,
    prompt_chars_limit: promptInfo?.limit ?? null,
    prompt_chars_headroom: promptInfo?.headroom ?? null,
    prompt_chars_dropped: promptInfo?.dropped ?? 0,
  }
}

// ── session totals (estimated turns only) ─────────────────────────────────

function emptyTotals() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, turns: 0 }
}

/**
 * Rolling per-session totals for providers that do NOT report real usage.
 * Claude and DeepSeek send real turn numbers already; summing those across
 * turns would double-count. `usage.estimated` marks a fallback-built object;
 * `usage.source === 'estimated'` is the canonical signal.
 */
function accumulate(session, usage) {
  const t = (session._usageTotals ||= emptyTotals())
  // Always remember the last real turn's split (input/output/total). Retained
  // turns only echo session.lastTokenUsage, so they never overwrite it.
  if (usage.source !== 'retained') {
    t.last = {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      source: usage.source || null,
    }
  }
  if (usage.source !== 'estimated') return t
  t.prompt_tokens += usage.prompt_tokens || 0
  t.completion_tokens += usage.completion_tokens || 0
  t.total_tokens += usage.total_tokens || 0
  t.turns += 1
  return t
}

function sessionTotals(session) {
  return session._usageTotals || emptyTotals()
}

module.exports = {
  CHARS_PER_TOKEN,
  buildUsage,
  accumulate,
  sessionTotals,
  estimateTokens,
  mergeUsage,
  normalizeUsage,
  splitKnownTotal,
  usageOfEvent,
  hasRealUsage: (value) => {
    const n = normalizeUsage(value)
    return (
      n !== null &&
      n.promptTokens !== null &&
      n.completionTokens !== null &&
      (n.promptTokens > 0 || n.completionTokens > 0)
    )
  },
}
