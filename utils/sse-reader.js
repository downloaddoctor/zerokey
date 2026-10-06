const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB cap on single-line buffer growth

/**
 * SSE reader for Web ReadableStream (fetch response body).
 *
 * @param {ReadableStream} stream - fetch().body
 * @param {object} options
 * @param {(parsed: object) => void} options.onData  - called with parsed JSON per data line
 * @param {() => void}               options.onDone  - called on [DONE] or stream end
 * @param {(err: Error) => void}     options.onError - called on read error
 * @param {(n: number) => void}     [options.onBytes] - called with byte count per chunk
 */
async function readSSE(stream, { onData, onDone, onError, onBytes }) {
  let buffer = ''
  let settled = false

  const finishOnce = (fn) => {
    if (settled) return
    settled = true
    fn()
  }

  const processLine = (line) => {
    if (line.startsWith('event:')) return
    if (!line.startsWith('data:')) return

    const dataStr = line.slice(5).trim()
    if (!dataStr) return
    if (dataStr === '[DONE]') {
      onDone()
      return
    }

    let data = dataStr
    try {
      data = JSON.parse(dataStr)
    } catch {
      return
    }

    try {
      onData(data)
    } catch (err) {
      onError(err)
    }
  }

  const processChunk = (chunk) => {
    if (onBytes && chunk.length) onBytes(chunk.length)
    buffer += chunk
    if (buffer.length > MAX_BUFFER_SIZE) {
      console.warn('[SSE] ⚠ Buffer exceeded 1MB — dropping line')
      buffer = ''
      return
    }
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      processLine(line)
    }
  }

  const decoder = new TextDecoder()

  // node-fetch returns a Node.js Readable; native fetch returns a WHATWG ReadableStream
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        processChunk(decoder.decode(value, { stream: true }))
      }
      finishOnce(onDone)
    } catch (err) {
      finishOnce(() => onError(err))
    }
  } else {
    await new Promise((resolve) => {
      stream.on('data', (chunk) => {
        processChunk(Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : chunk)
      })
      stream.on('end', () => {
        finishOnce(onDone)
        resolve()
      })
      stream.on('error', (err) => {
        finishOnce(() => onError(err))
        resolve()
      })
    })
  }
}

module.exports = { readSSE }
