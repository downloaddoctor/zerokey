'use strict'

const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB cap on single-line buffer growth

/**
 * SSE reader for Web ReadableStream (fetch response body).
 *
 * @param {ReadableStream} stream - fetch().body
 * @param {object} options
 * @param {(parsed: object) => void} options.onData  - called with parsed JSON per data line
 * @param {() => void}               options.onDone  - called on [DONE] or stream end
 * @param {(err: Error) => void}     options.onError - called on read error
 */
async function readSSE(stream, { onData, onDone, onError }) {
  let buffer = ''

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
    } catch (_) {
      return
    }

    try {
      onData(data)
    } catch (err) {
      console.error(err)
      onError(err)
    }
  }

  const processChunk = (chunk) => {
    buffer += chunk
    if (buffer.length > MAX_BUFFER_SIZE) {
      console.warn('[SSE] Buffer exceeded 1MB cap — dropping malformed line')
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
      onDone()
    } catch (err) {
      onError(err)
    }
  } else {
    await new Promise((resolve) => {
      stream.on('data', (chunk) => {
        processChunk(Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : chunk)
      })
      stream.on('end', () => { onDone(); resolve() })
      stream.on('error', (err) => { onError(err); resolve() })
    })
  }
}


module.exports = { readSSE }
