const { classifyError } = require('./errors')

/**
 * Factory for sendFinalChunk — shared by all stream handlers.
 * Closes stream, emits final tool calls, writes [DONE].
 * Session mutations (lastUsed etc.) happen in-memory — flushed to disk on shutdown via selector.flush().
 */
function createSendFinalChunk(res, session, parser, tokenUsage) {
  let finished = false
  return () => {
    if (finished) return
    finished = true
    parser.flush()
    parser.emit({}, 'stop', tokenUsage)
    res.write('data: [DONE]\n\n')
    res.end()
    session.lastUsed = new Date().toISOString()
  }
}

/**
 * Factory for onError — shared by all stream handlers.
 */
function createOnError(res, parser, provider) {
  let finished = false
  return (err) => {
    const classified = classifyError(err, provider)
    console.error(`[${provider}] Stream error (${classified.category}): ${err.message}`)
    if (finished) return
    finished = true
    parser.emit({}, 'error', {})
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ error: { message: classified.message, action: classified.action, category: classified.category } })}\n\n`,
      )
      res.end()
    }
  }
}

module.exports = { createSendFinalChunk, createOnError }
