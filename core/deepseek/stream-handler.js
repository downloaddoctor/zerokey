const { readSSE } = require('../../utils/sse-reader')

const RETRY_REASONS = {
  'Messages too frequent. Try again later.': true,
  'Server busy, please try again later.': true,
  'Server is busy. Try again later, or use Instant Mode.': true,
  'A message is being generated, please try again later.': true,
}

/**
 * DeepSeek SSE Stream Handler
 *
 * DeepSeek streams its assistant reply as an ordered list of fragments.
 * Each fragment has a `type`:
 *   - "THINK"    → chain-of-thought / reasoning text
 *   - "RESPONSE" → the user-visible answer
 *
 * Fragment lifecycle (verified against DevTools captures):
 *   1. Initial snapshot:  data: {"v":{"response":{...,"fragments":[{type:"THINK",content:"We"}]}}}
 *   2. Deltas while on a fragment (either shape):
 *        data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
 *        data: {"v":" answer"}
 *      Both target the *current last* fragment, so they must be routed by
 *      the tracked `currentFragmentType`.
 *   3. Thinking finalize marker: data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.66}
 *   4. Next fragment creation:   data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"Hi"}]}
 *      → switches `currentFragmentType` to the new fragment's type.
 *   5. Done: data: {"p":"response/status","o":"SET","v":"FINISHED"}
 *
 * THINK fragments are emitted as OpenAI-style `reasoning_content` deltas
 * (matching the Qwen handler); RESPONSE fragments go through `parser.scan`
 * so BPI tool-calls / raw text pass through the normal pipeline.
 *
 * Other event shapes:
 *   data: {"o":"SET","v":"FINISHED"}         → stream complete (legacy path)
 *   data: {"o":"BATCH","v":[...]}            → token usage
 */
function streamHandler(stream, session, parser, retry) {
  let cancelled = false
  let finished = false

  // Current fragment type: 'THINK' | 'RESPONSE' | null
  let currentFragmentType = null
  // Mirror Qwen: send an initial empty reasoning_content chunk once so
  // OpenAI-compatible clients open the reasoning channel.
  let hasSentReasoningRole = false

  const emitReasoning = (delta) => {
    if (!delta) return
    if (!hasSentReasoningRole) {
      parser.emit({ role: 'assistant', reasoning_content: '' })
      hasSentReasoningRole = true
    }
    parser.emit({ reasoning_content: delta })
  }

  const routeDelta = (text) => {
    if (!text) return
    if (currentFragmentType === 'THINK') emitReasoning(text)
    else parser.scan(text)
  }

  const doRetry = (reason) => {
    cancelled = true
    console.error(`[DeepSeek] Stream error: ${reason}`)
    parser.emitText(`\n\n⚠ Stream error: ${reason}\n`)

    if (RETRY_REASONS[reason] && retry) {
      console.debug('[DeepSeek] Retrying...')
      parser.emitText(`Retrying...\n`)
      try {
        stream.destroy()
      } catch {}
      retry()
        .then((newStream) => {
          streamHandler(newStream, session, parser, retry)
        })
        .catch((err) => {
          console.error(`[DeepSeek] Retry failed: ${err.message}`)
          parser.sendFinalChunk()
        })
      return
    }
    parser.sendFinalChunk()
  }

  const onData = (data) => {
    if (cancelled) return

    if (data.type === 'error') {
      doRetry(data.content)
      return
    }

    if (data.o === 'SET') {
      if (data.v === 'FINISHED') {
        finished = true
        parser.sendFinalChunk()
      }
      return
    }

    if (data.o === 'BATCH') {
      const usageEntry = data.v?.find((e) => e.p === 'accumulated_token_usage')
      const statusEntry = data.v?.find((e) => e.p === 'quasi_status')
      if (usageEntry) {
        parser.tokenUsage.prompt_tokens = 0
        parser.tokenUsage.completion_tokens = usageEntry.v
        parser.tokenUsage.total_tokens =
          parser.tokenUsage.completion_tokens + parser.tokenUsage.prompt_tokens
        console.debug(`[DeepSeek] Tokens: ${usageEntry.v} (status: ${statusEntry?.v ?? '-'})`)
      }
      return
    }

    // Initial response snapshot — carries message ids and the first fragment.
    const response = data.v?.response
    if (response) {
      session.parentMessageId = response.message_id
      session.lastUsed = new Date().toISOString()
      const firstFragment = response.fragments?.[0]
      if (firstFragment) {
        currentFragmentType = firstFragment.type || currentFragmentType
        routeDelta(firstFragment.content || '')
      }
      return
    }

    // Fragment APPEND — new fragment created; adopt its type and content.
    // Shape: {"p":"response/fragments","o":"APPEND","v":[{type,content,...}]}
    if (data.p === 'response/fragments' && data.o === 'APPEND' && Array.isArray(data.v)) {
      const frag = data.v[0]
      if (frag) {
        currentFragmentType = frag.type || currentFragmentType
        routeDelta(frag.content || '')
      }
      return
    }

    // Path-targeted content write to the current (last) fragment.
    // APPEND → incremental delta. SET → replace/seed the fragment's content.
    // Shapes:
    //   {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
    //   {"p":"response/fragments/-1/content","o":"SET","v":"text"}
    if (data.p === 'response/fragments/-1/content') {
      if (typeof data.v === 'string') routeDelta(data.v)
      return
    }

    // Bare delta — belongs to whichever fragment is currently last.
    if (typeof data.v === 'string') {
      routeDelta(data.v)
    }
  }

  const onDone = () => {
    if (cancelled) return
    if (finished) return
    doRetry('stream closed unexpectedly')
  }

  readSSE(stream, { onData, onDone, onError: (e) => parser.onError(e) })
}

module.exports = { streamHandler }
