// Token reporting: real provider numbers win, estimate is the fallback.
//
// Claude and DeepSeek fill parser.tokenUsage with real values from their
// stream handlers. ChatGPT and Qwen have nothing — the upstream sends no
// usage — so every turn reported `{input: 0, output: 0}` and a client could
// not see its own context growth. This fills only that gap.

const CHARS_PER_TOKEN = 4

// True when a usage object carries real numbers, not the empty stub.
function hasRealUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return false
  return (
    typeof tokenUsage.prompt_tokens === 'number' &&
    typeof tokenUsage.completion_tokens === 'number' &&
    typeof tokenUsage.total_tokens === 'number' &&
    (tokenUsage.prompt_tokens > 0 || tokenUsage.completion_tokens > 0)
  )
}

/**
 * Real usage if present, else a chars/4 estimate (prose approximation).
 *
 * @param {object|undefined} realUsage - parser.tokenUsage from the stream handler
 * @param {{chars: number}|undefined} promptInfo - compiler.lastPrompt
 * @param {number} modelChars - characters the upstream produced
 */
function buildUsage(realUsage, promptInfo, modelChars) {
  if (hasRealUsage(realUsage)) return realUsage

  const promptChars = promptInfo && typeof promptInfo.chars === 'number' ? promptInfo.chars : 0
  const promptTokens = Math.round(promptChars / CHARS_PER_TOKEN)
  const completionTokens = Math.round((modelChars || 0) / CHARS_PER_TOKEN)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true,
    // Truncation state of this turn (see compiler.limitPrompt). A client can
    // see the headroom and react before the provider limit starts dropping
    // content — that is what closes the compaction feedback loop.
    prompt_chars: promptChars,
    prompt_chars_limit: promptInfo?.limit ?? null,
    prompt_chars_headroom: promptInfo?.headroom ?? null,
    prompt_chars_dropped: promptInfo?.dropped ?? 0,
  }
}

module.exports = { buildUsage, hasRealUsage, CHARS_PER_TOKEN }
