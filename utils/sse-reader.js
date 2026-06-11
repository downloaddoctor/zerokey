'use strict'

const { Readable } = require('stream')

const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB cap on single-line buffer growth

/**
 * Shared SSE reader for both Web Streams and Node.js streams.
 *
 * Detects stream type:
 *   - Web Streams (ReadableStream) → uses getReader() + TextDecoder
 *   - Node.js streams (http.IncomingMessage) → uses on('data'/'end'/'error')
 *
 * @param {ReadableStream|import('stream').Readable} stream
 * @param {object} options
 * @param {(parsed: object) => void} options.onData  - called with parsed JSON per data line
 * @param {() => void}               options.onDone  - called on [DONE] or stream end
 * @param {(err: Error) => void}     options.onError - called on read error
 * @param {() => boolean}            options.isDone  - guard checked before each line
 */
async function readSSE(stream, { onData, onDone, onError, isDone }) {
  let buffer = ''

  const processLine = (line) => {
    if (isDone()) return
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
      return null
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
      if (isDone()) break
      processLine(line)
    }
  }

  const flushBuffer = () => {
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        processLine(line)
      }
    }
    console.log('[RES] DONE')
  }

  // ── Web Streams ──────────────────────────────────────────────
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        processChunk(decoder.decode(value, { stream: true }))
        if (isDone()) break
      }
      flushBuffer()
      onDone()
    } catch (err) {
      onError(err)
    }
    return
  }

  // ── Node.js stream ───────────────────────────────────────────
  await new Promise((resolve) => {
    stream.on('data', (chunk) => {
      if (isDone()) return
      processChunk(chunk.toString())
    })

    stream.on('end', () => {
      flushBuffer()
      onDone()
      resolve()
    })

    stream.on('error', (err) => {
      onError(err)
      resolve()
    })
  })
}

module.exports = { readSSE }
