/**
 * Base stream handler with common SSE parsing logic.
 * Provider-specific handlers extend this and override parseChunk().
 */
class BaseStreamHandler {
  constructor(pipeline, session) {
    this.pipeline = pipeline
    this.session = session
  }

  /**
   * Parse SSE chunk data. Override in subclass for provider-specific format.
   * @param {string} data - Raw SSE data line
   * @returns {{ text?: string, reasoning?: string, finish?: boolean }}
   */
  parseChunk(data) {
    return { text: data }
  }

  /**
   * Handle stream lifecycle.
   */
  async handleStream(stream) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        const lines = text.split('\n')

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          const parsed = this.parseChunk(data)
          if (parsed.text) this.pipeline.emitText(parsed.text)
          if (parsed.reasoning) this.pipeline.emitReasoning(parsed.reasoning)
          if (parsed.finish) this.pipeline.emitFinish()
        }
      }
    } catch (error) {
      this.pipeline.emitError(error)
      throw error
    } finally {
      reader.releaseLock()
    }
  }
}

module.exports = { BaseStreamHandler }
