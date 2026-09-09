const { readSSE } = require('../../utils/sse-reader')
const { LogSaver } = require('../../utils/log-saver')

const sseLog = new LogSaver({ name: 'glm-sse' })
const errorLog = new LogSaver({
  name: 'glm-error',
  beforeSave: (entry) => {
    if (!entry || typeof entry !== 'object') return null
    return {
      timestamp: entry.timestamp || new Date().toISOString(),
      scope: entry.scope || 'unknown',
      message: entry.message || 'Unknown error',
      ...(entry.extra ? { extra: entry.extra } : {}),
    }
  },
})

const RETRY_REASON_PATTERNS = [
  '请等待其他对话生成完毕',
  'Server busy',
  '请求过于频繁',
  '排队中',
  '开通会员',
  '高峰期',
]

const QUOTA_REASON_PATTERNS = ['您已多次体验过对话', '请登录后继续使用']

function matchesAny(text, patterns) {
  if (!text) return false
  return patterns.some((p) => text.includes(p))
}

function logGlmError(scope, message, extra) {
  errorLog.log({
    timestamp: new Date().toISOString(),
    scope,
    message,
    extra,
  })
}

function streamHandler(stream, session, parser, retry, onGuestQuotaExhausted) {
  let cancelled = false
  let finished = false
  let conversationId = ''
  let inThinking = false

  const doRetry = (reason) => {
    cancelled = true
    logGlmError('stream', String(reason))
    console.error(`[GLM] Stream error: ${reason}`)
    parser.emitText(`\n\n⚠ Stream error: ${reason}\n`)

    if (matchesAny(reason, RETRY_REASON_PATTERNS) && retry) {
      console.debug('[GLM] Retrying...')
      parser.emitText('Retrying...\n')
      try {
        stream.destroy()
      } catch {}
      retry()
        .then((newStream) => {
          streamHandler(newStream, session, parser, retry, onGuestQuotaExhausted)
        })
        .catch((err) => {
          logGlmError('retry_failed', err.message)
          console.error(`[GLM] Retry failed: ${err.message}`)
          parser.sendFinalChunk()
        })
      return
    }

    if (matchesAny(reason, QUOTA_REASON_PATTERNS) && onGuestQuotaExhausted) {
      console.debug('[GLM] Guest quota exhausted — respawning guest session...')
      parser.emitText('Respawned guest session...\n')
      try {
        stream.destroy()
      } catch {}
      onGuestQuotaExhausted()
        .then((newStream) => {
          streamHandler(newStream, session, parser, retry, onGuestQuotaExhausted)
        })
        .catch((err) => {
          logGlmError('guest_respawn_failed', err.message)
          console.error(`[GLM] Guest respawn failed: ${err.message}`)
          parser.sendFinalChunk()
        })
      return
    }

    parser.sendFinalChunk()
  }

  const onData = (data) => {
    sseLog.log(data)
    if (cancelled) return

    if (data.type === 'error') {
      doRetry(data.content)
      return
    }

    if (data.conversation_id && !conversationId) {
      conversationId = data.conversation_id
      session.chatSessionId = conversationId
      session.parentMessageId = conversationId
    }

    const status = String(data.status || '').toLowerCase()
    const lastError = data.last_error
    const topLevelMessage = data.message ?? data.err_msg
    const partError = Array.isArray(data.parts)
      ? data.parts.find((part) => part?.error?.message ?? part?.message)
      : null
    const partErrorMessage = partError?.error?.message ?? partError?.message

    const hasMeaningfulError =
      status === 'error' ||
      Boolean(topLevelMessage) ||
      Boolean(partErrorMessage) ||
      (lastError &&
        typeof lastError === 'object' &&
        (lastError.err_msg || lastError.message || lastError.error_code || lastError.code))

    if (hasMeaningfulError) {
      const errorMsg =
        topLevelMessage ??
        partErrorMessage ??
        lastError?.err_msg ??
        lastError?.message ??
        `GLM stream error status=${status || 'unknown'}`
      doRetry(String(errorMsg))
      return
    }

    if (Array.isArray(data.parts)) {
      for (const part of data.parts) {
        if (!part || typeof part !== 'object') continue
        if (part.status !== 'finish' || part.meta_data.extra) continue
        const contentItems = part.content || []

        for (const content of contentItems) {
          if (!content || typeof content !== 'object') continue

          if (content.type === 'think') {
            if (!inThinking) {
              inThinking = true
              parser.emitText('\n\n<think>')
            }
            parser.emitText(content.think)
          } else if (content.type === 'text') {
            if (inThinking) {
              inThinking = false
              parser.emitText('</think>\n')
            }
            session.lastUsed = new Date().toISOString()
            parser.scan(content.text)
          }
        }
      }
    }

    if (status === 'finish' || status === 'intervene') {
      if (inThinking) {
        inThinking = false
        parser.emitText('</think>\n')
      }
      finished = true
      parser.sendFinalChunk()
    }
  }

  const onDone = () => {
    if (cancelled) return
    if (finished) return
    if (inThinking) {
      inThinking = false
      parser.emitText('</think>\n')
    }
    finished = true
    parser.sendFinalChunk()
  }

  readSSE(stream, { onData, onDone, onError: (e) => parser.onError(e) })
}

module.exports = { streamHandler }
