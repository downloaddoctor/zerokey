const { readSSE } = require('../../utils/sse-reader')
const { LogSaver, serializeError } = require('../../utils/log-saver')

const streamLog = new LogSaver({ name: 'deepseek-error' })

const RETRY_REASONS = {
  'Messages too frequent. Try again later.': true,
  'Server busy, please try again later.': true,
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
 * so BLOCK tool-calls / raw text pass through the normal pipeline.
 *
 * Other event shapes:
 *   data: {"o":"SET","v":"FINISHED"}         → stream complete (legacy path)
 *   data: {"o":"BATCH","v":[...]}            → token usage
 */
function streamHandler(stream, session, parser, retry) {
  let cancelled = false
  let finished = false

  // Diagnostics — captured so a silent close can be logged with context.
  let dataCount = 0
  let producedOutput = false
  let lastEventType = null
  let lastError = null

  // Current fragment type: 'THINK' | 'RESPONSE' | null
  let currentFragmentType = null
  // OpenAI-compatible clients open the reasoning channel.
  let hasSentReasoningRole = false

  const emitReasoning = (delta) => {
    if (!delta) return
    producedOutput = true
    if (!hasSentReasoningRole) {
      parser.emit({ role: 'assistant', reasoning_content: '' })
      hasSentReasoningRole = true
    }
    parser.emit({ reasoning_content: delta })
  }

  const routeDelta = (text) => {
    if (!text) return
    producedOutput = true
    if (currentFragmentType === 'THINK') emitReasoning(text)
    else parser.scan(text)
  }

  const doRetry = (reason) => {
    cancelled = true
    console.error(`[DeepSeek] Stream error: ${reason}`)
    streamLog.log({
      ts: new Date().toISOString(),
      reason,
      chatSessionId: session.chatSessionId,
      parentMessageId: session.parentMessageId,
      currentFragmentType,
      lastEventType,
      dataCount,
      producedOutput,
      hasSentReasoningRole,
      retryable: !!RETRY_REASONS[reason] && !!retry,
      error: lastError,
    })
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
          streamLog.log({
            ts: new Date().toISOString(),
            reason: `retry failed — ${err?.message || err}`,
            chatSessionId: session.chatSessionId,
            parentMessageId: session.parentMessageId,
            dataCount,
            producedOutput,
            error: serializeError(err),
          })
          parser.sendFinalChunk()
        })
      return
    }
    parser.sendFinalChunk()
  }

  const onData = (data) => {
    if (cancelled) return
    dataCount++
    lastEventType = data.type || data.o || data.p || typeof data.v

    if (data.type === 'error') {
      lastError = serializeError(data)
      doRetry(data.content)
      return
    }

    if (data.o === 'SET') {
      if (data.v === 'FINISHED') {
        finished = true
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
    if (data.p === 'response/fragments' && data.o === 'APPEND' && Array.isArray(data.v)) {
      const frag = data.v[0]
      if (frag) {
        currentFragmentType = frag.type || currentFragmentType
        routeDelta(frag.content || '')
      }
      return
    }

    // Path-targeted content write to the current (last) fragment.
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
    if (finished) {
      parser.sendFinalChunk()
      return
    }
    doRetry(
      producedOutput
        ? 'stream closed unexpectedly (partial output)'
        : 'stream closed with no output',
    )
  }

  readSSE(stream, {
    onData,
    onDone,
    onError: (e) =>
      parser.onError(e, {
        source: 'stream',
        finished,
        lastEventType,
        dataCount,
        producedOutput,
        currentFragmentType,
      }),
  })
}

module.exports = { streamHandler }
