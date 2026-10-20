'use strict'

/**
 * HAR → capture converter + CLI.
 *
 * Two consumers:
 *  1. Library: harToCapture(harPath, outputDir) — one capture JSON per entry
 *     (legacy behavior, unchanged), used by core/session-selector.js.
 *  2. CLI: node utils/har-to-capture.js <file.har> [flags] — LLM-friendly.
 *     Produces ONE compact digest (.digest.txt + .digest.json), after
 *     filtering to meaningful endpoints, masking secrets and sizing bodies.
 *     This is what an agent should read, not the raw HAR.
 *
 * Defaults (no flags needed):
 *  - mask on, headers on, body size auto, noise filter on
 *  - output dir: temp/captures/ when the HAR is under a temp/ folder
 *
 * Flags:
 *  --out=DIR          output dir (default: temp/captures/ for temp/*.har)
 *  --mode=digest|captures|both   (default: digest)
 *  --filter=REGEX     keep only URLs matching REGEX (case-insensitive)
 *  --ignore=REGEX     drop URLs matching REGEX (repeatable)
 *  --method=GET,POST  keep only these methods (default: all)
 *  --status=2xx,4xx   keep only these status classes (default: all)
 *  --hosts=a,b        keep only these hostnames (default: all)
 *  --max-body=N|auto  truncate each body (default: auto; 0 = unlimited)
 *  --no-mask          use <redacted> instead of a fingerprint
 *  --no-redact        keep secrets verbatim
 *  --no-headers       omit request/response headers from digest
 *  --full             --max-body=0 --no-redact and disable noise filter
 *  --list             print a one-line-per-entry index and exit
 *  --json             with --list, emit JSON
 *
 * Noise patterns (analytics, fonts, images, telemetry) are dropped by default;
 * pass --filter to override, or --full to disable filtering.
 *
 * @typedef {Object} ConvertOptions
 * @property {RegExp} [filter]   keep only matching URLs
 * @property {RegExp[]} [ignore] drop matching URLs
 * @property {string[]} [methods] keep only these methods (upper-case)
 * @property {string[]} [statusClasses] keep only these classes ('2xx', …)
 * @property {string[]} [hosts] keep only these hostnames
 * @property {number|string} [maxBody] truncate bodies (number or 'auto')
 * @property {number} [entryCount] used to size 'auto' bodies
 * @property {boolean} [redact] redact secrets (default true)
 * @property {boolean} [mask] fingerprint secrets (default true)
 * @property {boolean} [headers] include headers in digest (default true)
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
require('./log')

// Substrings that mark an entry as infrastructural noise. An entry is dropped
// when its URL contains any of these, unless --filter/--full overrides.
const NOISE = [
  'google-analytics',
  'googletagmanager',
  'doubleclick',
  'segment.io',
  'segment.com',
  'sentry.io',
  'datadoghq',
  'hotjar',
  'mixpanel',
  'amplitude',
  'fullstory',
  'newrelic',
  'nr-data.net',
  'facebook.net',
  'clarity.ms',
  'bing.com/th',
  'fonts.googleapis',
  'fonts.gstatic',
  'cdn.jsdelivr',
  'unpkg.com',
  'jsdelivr.net',
  '/favicon',
  '.woff',
  '.woff2',
  '.ttf',
  '.css',
  '.js.map',
  '/static/media/',
  'gravatar.com',
  'intercom.io',
  'intercomcdn.com',
  'crisp.chat',
  'stripe.com/v3',
  'recaptcha',
  'cloudflareinsights',
  'challenges.cloudflare.com',
]

const SECRET_RE =
  /^(?:authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-csrf-token|x-xsrf-token|proxy-authorization)$/i

const SECRET_VALUE_RES = [
  /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  /\b(sk-)[A-Za-z0-9._-]{8,}/g,
  /\b(eyJ)[A-Za-z0-9._-]{20,}/g,
  /([?&](?:se|sig|sp|spr|srt|ss|st|sv|token|key|api_key|apikey|access_token)=)[^&#\s]*/gi,
]

const BODY_BUDGET = 150 * 1024
const BODY_MIN = 500
const BODY_MAX = 8000

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

function loadHar(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'))
  const entries = har && har.log && har.log.entries
  if (!Array.isArray(entries)) {
    throw new Error('Invalid HAR file: missing log.entries array')
  }
  return entries
}

function headersToObject(list) {
  const out = {}
  if (Array.isArray(list)) {
    for (const h of list) {
      if (h && h.name) out[String(h.name).toLowerCase()] = h.value
    }
  }
  return out
}

function parseBody(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// -- connect/gRPC body decoding ---------------------------------------------

const CONNECT_TYPES = ['application/connect+proto', 'application/grpc', 'application/grpc+proto']

function isConnectType(mime) {
  return typeof mime === 'string' && CONNECT_TYPES.some((t) => mime.includes(t))
}

/**
 * Decode a base64 HAR body to a string when the HAR marked it as such.
 * @param {string} text
 * @param {string} [encoding]
 * @returns {{text: string, binary: boolean}}
 */
function decodeBase64(text, encoding) {
  if (encoding !== 'base64' || typeof text !== 'string') {
    return { text: text || '', binary: false }
  }
  const buf = Buffer.from(text, 'base64')
  let printable = 0
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i]
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable += 1
  }
  const binary = buf.length > 0 && printable / buf.length < 0.85
  return { text: buf.toString('utf8'), binary }
}

/**
 * Split a Connect/gRPC stream: each frame is [1 byte flags][4 byte BE length][payload].
 * @param {Buffer} buf
 * @returns {{flags: number, data: Buffer}[]}
 */
function splitGrpcFrames(buf) {
  const frames = []
  let off = 0
  while (off + 5 <= buf.length) {
    const flags = buf[off]
    const len = buf.readUInt32BE(off + 1)
    if (off + 5 + len > buf.length) break
    frames.push({ flags, data: buf.subarray(off + 5, off + 5 + len) })
    off += 5 + len
  }
  return frames
}

/**
 * Best-effort protobuf wire walk: emit {field, wire, value} for length-delimited
 * (strings/JSON/bytes) and varint fields. Not a schema decode, but enough to
 * read a Connect payload and recover embedded JSON.
 * @param {Buffer} buf
 * @param {number} [depth]
 */
function walkProto(buf, depth = 0) {
  const out = []
  let off = 0
  if (depth > 3) return out
  while (off < buf.length) {
    let key = 0
    let shift = 0
    while (off < buf.length) {
      const b = buf[off]
      off += 1
      key += (b & 0x7f) * 2 ** shift
      shift += 7
      if ((b & 0x80) === 0) break
    }
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (field === 0) break
    if (wire === 0) {
      let val = 0
      let s = 0
      while (off < buf.length) {
        const b = buf[off]
        off += 1
        val += (b & 0x7f) * 2 ** s
        s += 7
        if ((b & 0x80) === 0) break
      }
      out.push({ field, wire: 'varint', value: val })
    } else if (wire === 2) {
      let len = 0
      let s = 0
      while (off < buf.length) {
        const b = buf[off]
        off += 1
        len += (b & 0x7f) * 2 ** s
        s += 7
        if ((b & 0x80) === 0) break
      }
      if (len > buf.length - off) break
      const slice = buf.subarray(off, off + len)
      off += len
      const asText = slice.toString('utf8')
      const isText =
        slice.length > 0 &&
        !asText.includes('\ufffd') &&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(asText)
      let json = null
      if (isText && asText.length > 1 && (asText[0] === '{' || asText[0] === '[')) {
        try {
          json = JSON.parse(asText)
        } catch {
          // not JSON, keep as text
        }
      }
      if (json !== null) out.push({ field, wire: 'len', value: json })
      else if (isText) out.push({ field, wire: 'len', value: asText })
      else out.push({ field, wire: 'len', value: walkProto(slice, depth + 1) })
    } else if (wire === 5) {
      off += 4
      out.push({ field, wire: 'i32' })
    } else if (wire === 1) {
      off += 8
      out.push({ field, wire: 'i64' })
    } else {
      break
    }
  }
  return out
}

/**
 * Turn a Connect/gRPC HAR body into a readable object.
 * @param {string} text raw HAR body
 * @param {string} [encoding] HAR content.encoding
 * @returns {{kind: string, frames?: object[], value?: any}}
 */
function decodeConnectBody(text, encoding) {
  // HAR stores binary bodies as base64, or as latin1 text when not marked.
  const buf = Buffer.from(text || '', encoding === 'base64' ? 'base64' : 'latin1')
  const frames = splitGrpcFrames(buf)
  if (frames.length === 0) return { kind: 'connect', value: buf.toString('latin1').slice(0, 4000) }
  return {
    kind: 'connect',
    frames: frames.map((f) => {
      let data = f.data
      if (f.flags & 0x01) {
        try {
          data = zlib.gunzipSync(data)
        } catch {
          // keep the raw payload
        }
      }
      return { flags: f.flags, proto: walkProto(data) }
    }),
  }
}

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

function methodOf(entry) {
  return String((entry.request && entry.request.method) || 'GET').toUpperCase()
}

function statusOf(entry) {
  return Number((entry.response && entry.response.status) || 0)
}

function hostOf(entry) {
  const url = (entry.request && entry.request.url) || ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function isNoise(url) {
  const lower = url.toLowerCase()
  return NOISE.some((token) => lower.includes(token))
}

function statusClass(status) {
  if (status >= 200 && status < 300) return '2xx'
  if (status >= 300 && status < 400) return '3xx'
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500) return '5xx'
  return '0xx'
}

/**
 * @param {object[]} entries
 * @param {ConvertOptions} opts
 * @returns {object[]}
 */
function selectEntries(entries, opts) {
  const o = opts || {}
  const methods = o.methods ? new Set(o.methods.map((m) => m.toUpperCase())) : null
  const classes = o.statusClasses ? new Set(o.statusClasses) : null
  const hosts = o.hosts ? new Set(o.hosts.map((h) => h.toLowerCase())) : null
  const ignores = o.ignore && o.ignore.length ? o.ignore : null

  return entries.filter((entry) => {
    const url = (entry.request && entry.request.url) || ''
    if (o.filter && !o.filter.test(url)) return false
    if (ignores && ignores.some((re) => re.test(url))) return false
    if (methods && !methods.has(methodOf(entry))) return false
    if (classes && !classes.has(statusClass(statusOf(entry)))) return false
    if (hosts && !hosts.has(hostOf(entry).toLowerCase())) return false
    if (o.autoNoise !== false && !o.filter && isNoise(url)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// redaction + truncation
// ---------------------------------------------------------------------------

/**
 * Fingerprint a secret without revealing it: first 6 chars + total length.
 * Short values (<= 12 chars) are masked entirely.
 */
function maskSecret(value) {
  const s = String(value)
  if (s.length <= 12) return '<masked:' + s.length + '>'
  return s.slice(0, 6) + '…<masked:' + s.length + '>'
}

/**
 * Mask a Cookie/Set-Cookie header while preserving its STRUCTURE: one entry
 * per cookie with the real name and a fingerprinted value.
 *
 *   'a=1; b=2'  →  { count: 2, cookies: { a: '<masked:1>', b: '<masked:1>' } }
 */
function maskCookieHeader(value) {
  const parts = String(value)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  const cookies = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      cookies[part] = '<flag>'
      continue
    }
    cookies[part.slice(0, eq).trim()] = maskSecret(part.slice(eq + 1))
  }
  return { count: parts.length, cookies }
}

/**
 * Mask an Authorization header while keeping the scheme,
 * e.g. 'Bearer eyJ…' → 'Bearer <masked:N>'.
 */
function maskAuthHeader(value) {
  const s = String(value)
  const sp = s.indexOf(' ')
  if (sp === -1) return maskSecret(s)
  return s.slice(0, sp) + ' ' + maskSecret(s.slice(sp + 1))
}

function redactString(value, mask) {
  let out = value
  for (const re of SECRET_VALUE_RES) out = out.replace(re, mask ? maskSecret : '$1<redacted>')
  return out
}

function redactHeaders(headers, mask) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const isSecret = SECRET_RE.test(k)
    if (!isSecret) {
      out[k] = typeof v === 'string' ? redactString(v, mask) : v
      continue
    }
    if (!mask || typeof v !== 'string') {
      out[k] = '<redacted>'
      continue
    }
    if (k === 'cookie' || k === 'set-cookie') {
      out[k] = maskCookieHeader(v)
      continue
    }
    if (k === 'authorization' || k === 'proxy-authorization') {
      out[k] = maskAuthHeader(v)
      continue
    }
    out[k] = maskSecret(v)
  }
  return out
}

function redactBody(body, mask) {
  if (typeof body === 'string') return redactString(body, mask)
  if (body === null || typeof body !== 'object') return body
  if (Array.isArray(body)) return body.map((v) => redactBody(v, mask))
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_RE.test(k)) {
      out[k] = typeof v === 'string' && mask ? maskSecret(v) : '<redacted>'
      continue
    }
    out[k] = redactBody(v, mask)
  }
  return out
}

/**
 * Shorten a value for digest output. Strings/objects are truncated with a
 * marker. Returns the value unchanged when max <= 0.
 */
function truncate(value, max) {
  if (max <= 0) return value
  let text
  if (typeof value === 'string') text = value
  else if (value === null || value === undefined) return value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= max) return value
  return text.slice(0, max) + '…<' + (text.length - max) + ' chars>'
}

/**
 * Auto body sizing: total body budget (~150 KB) split across entries,
 * clamped to [500, 8000]. 'auto' => per-entry share; a number is exact;
 * 0 disables truncation.
 * @param {number|string} [maxBody]
 * @param {number} [entryCount]
 * @returns {number}
 */
function resolveMaxBody(maxBody, entryCount) {
  if (maxBody === 0) return 0
  if (Number.isInteger(maxBody)) return maxBody
  const n = Number.isInteger(entryCount) && entryCount > 0 ? entryCount : 1
  const per = Math.floor(BODY_BUDGET / n)
  return Math.max(BODY_MIN, Math.min(BODY_MAX, per))
}

// ---------------------------------------------------------------------------
// legacy library API
// ---------------------------------------------------------------------------

/**
 * Convert a HAR JSON file into the network-capture format used by deepseek4free.
 * One file per entry; unchanged public behavior.
 *
 * @param {string} harPath
 * @param {string} [outputDir]
 * @returns {string[]} paths of generated capture files
 */
function harToCapture(harPath, outputDir) {
  const entries = loadHar(harPath)
  const dir = outputDir || path.dirname(harPath)
  const generated = []
  for (const entry of entries) {
    const capture = convertEntry(entry)
    if (!capture) continue
    const url = capture.request.url
    let host = 'unknown'
    try {
      host = new URL(url).hostname
    } catch {
      // keep fallback
    }
    const ts = capture.meta.timestamp
      ? new Date(capture.meta.timestamp).toISOString().replace(/[:.]/g, '-')
      : new Date().toISOString().replace(/[:.]/g, '-')
    const filename = 'network-capture-' + host + '-' + ts + '.json'
    const filePath = path.join(dir, filename)
    fs.writeFileSync(filePath, JSON.stringify(capture, null, 2), 'utf8')
    generated.push(filePath)
    console.success('[harToCapture] Generated: ' + filename)
  }
  return generated
}

/** Convert a single HAR entry to a network-capture object (legacy shape). */
function convertEntry(entry) {
  const request = entry.request
  const response = entry.response
  if (!request || !response) return null
  const reqBody = request.postData ? parseBody(request.postData.text) : null
  const resBody = response.content ? parseBody(response.content.text) : null
  const started = entry.startedDateTime
  return {
    captured_at: started ? new Date(started).toISOString() : new Date().toISOString(),
    request: {
      method: request.method,
      url: request.url,
      headers: headersToObject(request.headers),
      body: reqBody,
    },
    response: {
      status: response.status,
      statusText: response.statusText || '',
      headers: headersToObject(response.headers),
      body: resBody,
    },
    meta: {
      type: 'fetch',
      duration: entry.time || 0,
      timestamp: started || new Date().toISOString(),
      error: response.status >= 400 ? 'HTTP ' + response.status : null,
    },
  }
}

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

/**
 * Build the compact, LLM-readable digest for one entry.
 * @param {object} entry
 * @param {ConvertOptions} opts
 */
function digestEntry(entry, opts) {
  const o = opts || {}
  const max = resolveMaxBody(o.maxBody, o.entryCount)
  const doRedact = o.redact !== false
  const doMask = o.mask !== false
  const withHeaders = o.headers !== false

  const request = entry.request || {}
  const response = entry.response || {}
  const reqHeaders = headersToObject(request.headers)
  const resHeaders = headersToObject(response.headers)
  const reqMime = (request.postData && request.postData.mimeType) || ''
  const resMime = (response.content && response.content.mimeType) || ''
  const resEnc = response.content && response.content.encoding

  const reqBody = request.postData
    ? isConnectType(reqMime)
      ? decodeConnectBody(request.postData.text, request.postData.encoding)
      : parseBody(request.postData.text)
    : null
  const resBody = response.content
    ? isConnectType(resMime)
      ? decodeConnectBody(response.content.text, resEnc)
      : parseBody(decodeBase64(response.content.text, resEnc).text)
    : null

  const req = {
    method: request.method,
    url: request.url,
    body: truncate(doRedact ? redactBody(reqBody, doMask) : reqBody, max),
  }
  if (withHeaders) req.headers = doRedact ? redactHeaders(reqHeaders, doMask) : reqHeaders

  const res = {
    status: response.status,
    statusText: response.statusText || '',
    mimeType: resMime,
    body: truncate(doRedact ? redactBody(resBody, doMask) : resBody, max),
  }
  if (withHeaders) res.headers = doRedact ? redactHeaders(resHeaders, doMask) : resHeaders

  return {
    time: entry.startedDateTime || null,
    duration: entry.time || 0,
    request: req,
    response: res,
  }
}

function compactUrl(url) {
  try {
    const u = new URL(url)
    return u.hostname + u.pathname + (u.search ? u.search : '')
  } catch {
    return url
  }
}

/** One line per entry, for --list and the digest INDEX. */
function indexLine(entry, i) {
  const status = statusOf(entry)
  const method = methodOf(entry).padEnd(6)
  const dur = String(Math.round(entry.time || 0)).padStart(6)
  const size = String(
    (entry.response && entry.response.content && entry.response.content.size) || 0,
  ).padStart(8)
  return (
    String(i).padStart(4) +
    '  ' +
    method +
    ' ' +
    String(status).padEnd(3) +
    ' ' +
    dur +
    'ms ' +
    size +
    'B  ' +
    compactUrl((entry.request && entry.request.url) || '')
  )
}

function buildDigest(harPath, entries, opts, selected) {
  const o = Object.assign({}, opts, { entryCount: selected.length })
  const max = resolveMaxBody(o.maxBody, selected.length)
  const lines = []
  lines.push('HAR digest: ' + path.basename(harPath))
  lines.push(
    'entries: ' +
      selected.length +
      ' of ' +
      entries.length +
      '  |  max-body: ' +
      (max > 0 ? max + ' chars' : 'unlimited') +
      '  |  redact: ' +
      (o.redact !== false ? (o.mask !== false ? 'mask' : 'true') : 'false') +
      '  |  headers: ' +
      (o.headers !== false),
  )
  lines.push('')
  lines.push('INDEX')
  selected.forEach((entry, i) => lines.push(indexLine(entry, i)))
  lines.push('')
  lines.push('ENTRIES')
  selected.forEach((entry, i) => {
    lines.push('')
    lines.push('--- [' + i + '] ' + methodOf(entry) + ' ' + statusOf(entry) + ' ---')
    lines.push(JSON.stringify(digestEntry(entry, o), null, 2))
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    file: null,
    out: null,
    mode: 'digest',
    filter: null,
    ignore: [],
    methods: null,
    statusClasses: null,
    hosts: null,
    maxBody: 'auto',
    redact: true,
    mask: true,
    headers: true,
    full: false,
    list: false,
    json: false,
  }
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      opts.file = opts.file || arg
      continue
    }
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const val = eq === -1 ? '' : arg.slice(eq + 1)
    switch (key) {
      case 'out':
        opts.out = val
        break
      case 'mode':
        opts.mode = val
        break
      case 'filter':
        opts.filter = new RegExp(val, 'i')
        break
      case 'ignore':
        opts.ignore.push(new RegExp(val, 'i'))
        break
      case 'method':
        opts.methods = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case 'status':
        opts.statusClasses = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case 'hosts':
        opts.hosts = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case 'max-body':
        opts.maxBody = val === 'auto' || val === '' ? 'auto' : Number(val) || 0
        break
      case 'no-mask':
        opts.mask = false
        break
      case 'no-redact':
        opts.redact = false
        break
      case 'no-headers':
        opts.headers = false
        break
      case 'full':
        opts.full = true
        opts.maxBody = 0
        opts.redact = false
        opts.mask = false
        break
      case 'list':
        opts.list = true
        break
      case 'json':
        opts.json = true
        break
      default:
        throw new Error('unknown flag: --' + key)
    }
  }
  return opts
}

function usage() {
  const self = path.basename(process.argv[1] || 'har-to-capture.js')
  return [
    'Usage: node utils/' + self + ' <file.har> [flags]',
    '',
    '  --out=DIR          output dir (default: temp/captures/ for temp/*.har)',
    '  --mode=digest|captures|both   (default: digest)',
    '  --filter=REGEX     keep only URLs matching REGEX',
    '  --ignore=REGEX     drop URLs matching REGEX (repeatable)',
    '  --method=GET,POST  keep only these methods',
    '  --status=2xx,4xx   keep only these status classes',
    '  --hosts=a,b        keep only these hostnames',
    '  --max-body=N|auto  truncate bodies (default auto; 0 = unlimited)',
    '  --no-mask          use <redacted> instead of a fingerprint (mask is default)',
    '  --no-redact        keep secrets verbatim',
    '  --no-headers       omit headers from the digest',
    '  --full             --max-body=0 --no-redact and disable noise filter',
    '  --list             print the entry index and exit',
    '  --json             with --list, emit JSON',
  ].join('\n')
}

/**
 * Default output dir: temp/captures/ when the HAR lives under a temp/ folder
 * (the repo convention), otherwise alongside the HAR.
 * @param {string} harPath
 * @returns {string}
 */
function defaultOutDir(harPath) {
  const dir = path.dirname(harPath)
  if (path.basename(dir).toLowerCase() === 'temp') return path.join(dir, 'captures')
  return dir
}

function runCli() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.file) {
    console.error(usage())
    process.exit(1)
  }
  if (!fs.existsSync(opts.file)) {
    console.error('file not found: ' + opts.file)
    process.exit(1)
  }

  const entries = loadHar(opts.file)
  const selected = selectEntries(entries, {
    filter: opts.filter,
    ignore: opts.ignore,
    methods: opts.methods,
    statusClasses: opts.statusClasses,
    hosts: opts.hosts,
    autoNoise: !opts.full,
  })

  if (opts.list) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          selected.map((e, i) => ({
            i,
            method: methodOf(e),
            status: statusOf(e),
            url: (e.request && e.request.url) || '',
          })),
          null,
          2,
        ) + '\n',
      )
    } else {
      process.stdout.write('kept ' + selected.length + ' of ' + entries.length + '\n')
      selected.forEach((e, i) => process.stdout.write(indexLine(e, i) + '\n'))
    }
    return
  }

  const outDir = opts.out || defaultOutDir(opts.file)
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.basename(opts.file).replace(/\.har$/i, '')

  if (opts.mode === 'captures' || opts.mode === 'both') {
    harToCapture(opts.file, outDir)
  }
  if (opts.mode === 'digest' || opts.mode === 'both') {
    const digest = buildDigest(opts.file, entries, opts, selected)
    const txtPath = path.join(outDir, base + '.digest.txt')
    const jsonPath = path.join(outDir, base + '.digest.json')
    fs.writeFileSync(txtPath, digest, 'utf8')
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          source: path.basename(opts.file),
          kept: selected.length,
          total: entries.length,
          entries: selected.map((e) =>
            digestEntry(e, Object.assign({}, opts, { entryCount: selected.length })),
          ),
        },
        null,
        2,
      ),
      'utf8',
    )
    console.success('[har] digest: ' + txtPath + ' (' + selected.length + ' entries)')
    console.success('[har] json:   ' + jsonPath)
  }
}

if (require.main === module) {
  try {
    runCli()
  } catch (err) {
    console.error(err.message || String(err))
    process.exit(1)
  }
}

module.exports = {
  harToCapture,
  convertEntry,
  loadHar,
  selectEntries,
  digestEntry,
  buildDigest,
  parseArgs,
  defaultOutDir,
  resolveMaxBody,
  decodeConnectBody,
  walkProto,
  splitGrpcFrames,
  maskSecret,
  maskCookieHeader,
  maskAuthHeader,
}
