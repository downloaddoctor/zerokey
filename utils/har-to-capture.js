const fs = require('fs')
const path = require('path')

/**
 * Convert a HAR JSON file into the network-capture format used by deepseek4free.
 *
 * HAR (HTTP Archive 1.2):
 *   { log: { entries: [{ request: { method, url, headers[], postData?: { text } },
 *                         response: { status, statusText, headers[], content: { text? } },
 *                         startedDateTime, time }] } }
 *
 * Network-capture (deepseek4free):
 *   { captured_at, request: { method, url, headers: {}, body },
 *     response: { source, status, statusText, headers: {}, body },
 *     meta: { type, duration, timestamp, error } }
 *
 * @param {string} harPath - Path to the HAR JSON file
 * @param {string} outputDir - Directory to write capture JSON files (default: same dir as HAR)
 * @returns {string[]} Paths of generated capture files
 */
function harToCapture(harPath, outputDir) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'))
  const entries = har?.log?.entries

  if (!entries || !Array.isArray(entries)) {
    throw new Error('Invalid HAR file: missing log.entries array')
  }

  if (!outputDir) {
    outputDir = path.dirname(harPath)
  }

  const generatedFiles = []

  for (const entry of entries) {
    const capture = convertEntry(entry)
    if (!capture) continue

    // Generate filename: network-capture-{host}-{timestamp}.json
    const url = capture.request.url
    let host = 'unknown'
    try {
      host = new URL(url).hostname
    } catch {}

    const ts = capture.meta.timestamp
      ? new Date(capture.meta.timestamp).toISOString().replace(/[:.]/g, '-')
      : new Date().toISOString().replace(/[:.]/g, '-')

    const filename = `network-capture-${host}-${ts}.json`
    const filePath = path.join(outputDir, filename)

    fs.writeFileSync(filePath, JSON.stringify(capture, null, 2), 'utf8')
    generatedFiles.push(filePath)
    console.success(`[harToCapture] Generated: ${filename}`)
  }

  return generatedFiles
}

/**
 * Convert a single HAR entry to a network-capture object.
 */
function convertEntry(entry) {
  const { request, response, startedDateTime, time } = entry

  if (!request || !response) return null

  // ── Request ──
  const reqHeaders = {}
  if (Array.isArray(request.headers)) {
    for (const h of request.headers) {
      reqHeaders[h.name.toLowerCase()] = h.value
    }
  }

  // Parse request body from postData
  let reqBody = null
  if (request.postData?.text) {
    try {
      reqBody = JSON.parse(request.postData.text)
    } catch {
      reqBody = request.postData.text
    }
  }

  // ── Response ──
  const resHeaders = {}
  if (Array.isArray(response.headers)) {
    for (const h of response.headers) {
      resHeaders[h.name.toLowerCase()] = h.value
    }
  }

  // Parse response body from content
  let resBody = null
  if (response.content?.text) {
    try {
      resBody = JSON.parse(response.content.text)
    } catch {
      resBody = response.content.text
    }
  }

  // ── Assemble capture ──
  return {
    captured_at: startedDateTime
      ? new Date(startedDateTime).toISOString()
      : new Date().toISOString(),
    request: {
      method: request.method,
      url: request.url,
      headers: reqHeaders,
      body: reqBody,
    },
    response: {
      status: response.status,
      statusText: response.statusText || '',
      headers: resHeaders,
      body: resBody,
    },
    meta: {
      type: 'fetch',
      duration: time || 0,
      timestamp: startedDateTime || new Date().toISOString(),
      error: response.status >= 400 ? `HTTP ${response.status}` : null,
    },
  }
}

module.exports = { harToCapture, convertEntry }
