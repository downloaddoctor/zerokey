'use strict'

/**
 * Claude Connect-RPC transport (CURRENT claude.ai web protocol, 2026).
 *
 * The old REST `/api/organizations/.../chat_conversations/.../completion` SSE
 * endpoint is legacy. The live web client speaks Connect-RPC over gRPC framing:
 *
 *   POST https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline
 *   content-type: application/connect+proto
 *   body: base64 of [1 byte flags][4 byte BE length][protobuf payload] frames
 *
 * This is a SELF-CONTAINED codec + client so the provider can speak both
 * protocols. The router prefers this transport and falls back to api.js for
 * stale captures. See providers/claude/api.md for the recovered field map.
 *
 * Protobuf handling is schema-less: the wire format is read/written directly
 * (varint + length-delimited), enough to reproduce observed request fields and
 * walk response frames.
 */

const zlib = require('zlib')
const crypto = require('crypto')
const { BaseAPI } = require('../base/BaseAPI')
const { assertOk } = require('../../utils/http-error')
const { uuid } = require('../../utils/uuid')

const RPC_BASE = 'https://claude.ai/claudeai-rpc'
const SERVICE = 'anthropic.bard.api.v1alpha.ConversationService'

const CONNECT_CONTENT_TYPE = 'application/connect+proto'
const CONNECT_PROTOCOL_VERSION = '1'

// ── protobuf wire codec ─────────────────────────────────────────────────────

const WIRE_VARINT = 0
const WIRE_I64 = 1
const WIRE_LEN = 2
const WIRE_I32 = 5

/** Encode an unsigned varint. */
function writeVarint(value) {
  const bytes = []
  let v = Math.floor(Number(value))
  while (v > 0x7f) {
    bytes.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

/** Encode a length-delimited field (wire type 2). */
function writeLenField(field, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return Buffer.concat([writeVarint((field << 3) | WIRE_LEN), writeVarint(data.length), data])
}

/** Encode a varint field (wire type 0). */
function writeVarintField(field, value) {
  return Buffer.concat([writeVarint((field << 3) | WIRE_VARINT), writeVarint(value)])
}

/** Read one varint from buf at off; returns [value, nextOff]. */
function readVarint(buf, off) {
  let value = 0
  let shift = 0
  while (off < buf.length) {
    const b = buf[off]
    off += 1
    value += (b & 0x7f) * 2 ** shift
    shift += 7
    if ((b & 0x80) === 0) break
  }
  return [value, off]
}

/** Best-effort decode of a length-delimited payload. */
function decodeLenValue(slice, depth) {
  const text = slice.toString('utf8')
  const printable = !text.includes('\ufffd') && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
  if (printable && text.length > 0) {
    if (text.length > 1 && (text[0] === '{' || text[0] === '[')) {
      try {
        return JSON.parse(text)
      } catch {
        // fall through to plain text
      }
    }
    return text
  }
  if (slice.length === 0) return ''
  return walkProto(slice, depth + 1)
}

/**
 * Schema-less protobuf walk. Returns [{ field, wire, value }] in wire order.
 * @param {Buffer} buf
 * @param {number} [depth]
 */
function walkProto(buf, depth = 0) {
  const out = []
  let off = 0
  if (depth > 4) return out
  while (off < buf.length) {
    let key
    ;[key, off] = readVarint(buf, off)
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (field === 0) break
    if (wire === WIRE_VARINT) {
      let value
      ;[value, off] = readVarint(buf, off)
      out.push({ field, wire: 'varint', value })
    } else if (wire === WIRE_LEN) {
      let len
      ;[len, off] = readVarint(buf, off)
      if (len > buf.length - off) break
      const slice = buf.subarray(off, off + len)
      off += len
      out.push({ field, wire: 'len', value: decodeLenValue(slice, depth) })
    } else if (wire === WIRE_I32) {
      off += 4
      out.push({ field, wire: 'i32' })
    } else if (wire === WIRE_I64) {
      off += 8
      out.push({ field, wire: 'i64' })
    } else {
      break
    }
  }
  return out
}

// ── connect framing ─────────────────────────────────────────────────────────

/**
 * Wrap one protobuf payload in a Connect/gRPC frame:
 *   [1 byte flags][4 byte big-endian length][payload]
 * @param {Buffer} payload
 * @param {number} [flags] 0 = message, 1 = end-of-stream
 */
function frame(payload, flags = 0) {
  const head = Buffer.alloc(5)
  head.writeUInt8(flags, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/**
 * Split a Connect/gRPC stream into frames.
 * @param {Buffer} buf
 * @returns {{flags: number, data: Buffer}[]}
 */
function unframe(buf) {
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
 * A Connect frame with the compressed bit (0x01) set carries a gzip payload.
 * Returns the decompressed bytes, or the input unchanged when not compressed.
 * @param {{flags: number, data: Buffer}} frame
 * @returns {Buffer}
 */
function decompressFrame(frame) {
  if ((frame.flags & 0x01) === 0) return frame.data
  try {
    return zlib.gunzipSync(frame.data)
  } catch {
    return frame.data
  }
}

/**
 * Connect end-of-stream frame (flags & 0x02) carries JSON `{error?, metadata?}`.
 * Returns an Error with the real server code/message, or null on a clean end.
 * @param {{flags: number, data: Buffer}} f
 * @returns {Error|null}
 */
function endStreamError(f) {
  let raw = ''
  try {
    raw = decompressFrame(f).toString('utf8')
    const json = raw ? JSON.parse(raw) : {}
    if (!json.error) return null
    const err = new Error(
      `Connect error ${json.error.code || 'unknown'}: ${json.error.message || raw}`,
    )
    err.code = json.error.code
    err.details = json.error.details
    return err
  } catch {
    return raw ? new Error(`Connect end-of-stream (unparsed): ${raw.slice(0, 500)}`) : null
  }
}

// ── request builders ────────────────────────────────────────────────────────

/**
 * Build the StreamTimeline protobuf from the field map recovered from the HAR:
 *   field 1 (string)  conversation UUID
 *   field 3 (varint)  request kind (1)
 *   field 4 (message) settings { field 6 varint = 1 }
 *   field 5 (string)  locale (e.g. en-US)
 *   field 6 (varint)  flags (1)
 *   field 8 (string)  timezone (e.g. America/Chicago)
 *
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {string} [opts.locale]
 * @param {string} [opts.timezone]
 * @returns {Buffer}
 */
function buildStreamTimeline({
  conversationId,
  locale = 'en-US',
  timezone = 'UTC',
  cursor = '',
  initial = false,
}) {
  const settings = writeVarintField(6, 1)
  return Buffer.concat([
    writeLenField(1, conversationId),
    cursor ? writeLenField(2, writeLenField(1, cursor)) : Buffer.alloc(0),
    writeVarintField(3, 1),
    writeLenField(4, settings),
    writeLenField(5, locale),
    // HAR claude4: the very first open of a brand-new chat omits f6.
    initial ? Buffer.alloc(0) : writeVarintField(6, 1),
    writeLenField(8, timezone),
  ])
}

/**
 * Build a PerformAction protobuf (message send).
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {Buffer|string} [opts.actionPayload]
 * @returns {Buffer}
 */
const CAPABILITY_FLAGS = [1, 2, 3, 6, 7, 8, 10]

function capabilities() {
  return Buffer.concat(CAPABILITY_FLAGS.map((n) => writeVarintField(n, 1)))
}

// HAR claude4: the client tool set sent with the first (model-bearing) actions.
const CLIENT_TOOLS = ['local:visualize:read_me', 'local:visualize:show_widget']

/** f8 tool config: f8{f1{f1=1, f7=1, f8{f1{f1 name, f2=0}...}, f10=0, f14=1}} */
function toolConfig(tools = CLIENT_TOOLS) {
  const list = tools.map((n) =>
    writeLenField(1, Buffer.concat([writeLenField(1, n), writeVarintField(2, 0)])),
  )
  return writeLenField(
    1,
    Buffer.concat([
      writeVarintField(1, 1),
      writeVarintField(7, 1),
      writeLenField(8, Buffer.concat(list)),
      writeVarintField(10, 0),
      writeVarintField(14, 1),
    ]),
  )
}

function clientContext(timezone, locale) {
  return Buffer.concat([
    writeLenField(12, timezone),
    writeLenField(13, locale),
    writeVarintField(18, 1),
  ])
}

/**
 * The 32-byte f15 blob carried by every session-bearing action. Not derivable
 * from the HARs (no hash of the known inputs matches); needs the claude.ai JS
 * bundle. Isolated here so the rest of the send path is complete.
 */
function actionSignature(captured) {
  const mode = process.env.ZEROKEY_CLAUDE_F15_PROBE
  if (mode === 'zero') return Buffer.alloc(32)
  if (mode === 'random') return crypto.randomBytes(32)
  // Replay the f15 from the captured fetch body. It is a per-message device
  // signature, so the server may reject a replay; the real error is logged.
  if (Buffer.isBuffer(captured) && captured.length === 32) return captured
  throw new Error(
    'PerformAction f15 signature is not reverse-engineered yet — use CLAUDE_TRANSPORT=completion to send',
  )
}

/**
 * Promptless PerformAction (model/tools/effort setup, no session yet).
 * Shape: f1{f2 conv, f3=3, f7 caps, f14 locale}, f15{f1{f12 tz, f13 locale, f18=1}}
 */
function buildPromptlessAction({ conversationId, locale = 'en-US', timezone = 'UTC', model }) {
  const head = Buffer.concat([
    writeLenField(2, conversationId),
    writeVarintField(3, 3),
    writeLenField(7, capabilities()),
    writeLenField(14, locale),
  ])
  return Buffer.concat([
    writeLenField(1, head),
    writeLenField(
      15,
      writeLenField(
        1,
        Buffer.concat([
          ...(model
            ? [writeLenField(7, writeLenField(2, model)), writeLenField(8, toolConfig())]
            : []),
          clientContext(timezone, locale),
        ]),
      ),
    ),
  ])
}

/**
 * Prompt PerformAction. Shape:
 *   f1{ f1{f1 sessionId, f2 seq}, f2 conv, f3=3, f7 caps, f14 locale, f15 signature }
 *   f2{ f1 messageId, f2 replyId, f3 prompt, f7{f2 model}?, f12 tz, f13 locale, f18=1 }
 */
function buildPromptAction({
  conversationId,
  sessionId,
  seq,
  messageId,
  signature,
  toolConfigRaw,
  replyId,
  prompt,
  model,
  locale = 'en-US',
  timezone = 'UTC',
}) {
  const session = Buffer.concat([writeLenField(1, sessionId), writeVarintField(2, seq)])
  const head = Buffer.concat([
    writeLenField(1, session),
    writeLenField(2, conversationId),
    writeVarintField(3, 3),
    writeLenField(7, capabilities()),
    writeLenField(14, locale),
    writeLenField(15, actionSignature(signature)),
  ])
  const parts = [writeLenField(1, messageId), writeLenField(2, replyId), writeLenField(3, prompt)]
  if (model) parts.push(writeLenField(7, writeLenField(2, model)))
  if (model) parts.push(writeLenField(8, toolConfigRaw || toolConfig()))
  parts.push(clientContext(timezone, locale))
  return Buffer.concat([writeLenField(1, head), writeLenField(2, Buffer.concat(parts))])
}

// ── incremental frame reader ────────────────────────────────────────────────

/** Undecoded top-level protobuf fields: [{field, wire, value?, bytes?}]. */
function rawFields(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    let key
    ;[key, off] = readVarint(buf, off)
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (field === 0) break
    if (wire === WIRE_VARINT) {
      let value
      ;[value, off] = readVarint(buf, off)
      out.push({ field, wire, value })
    } else if (wire === WIRE_LEN) {
      let len
      ;[len, off] = readVarint(buf, off)
      if (len > buf.length - off) break
      out.push({ field, wire, bytes: buf.subarray(off, off + len) })
      off += len
    } else if (wire === WIRE_I32) {
      off += 4
    } else if (wire === WIRE_I64) {
      off += 8
    } else {
      break
    }
  }
  return out
}

/** Exact request body bytes stored by the session selector (base64), or null. */
function capturedBody(parsedFetch) {
  const b64 = parsedFetch && parsedFetch.bodyBase64
  return b64 ? Buffer.from(b64, 'base64') : null
}

/**
 * Pull reusable values out of the captured request body (a PerformAction, or a
 * Connect-framed StreamTimeline): locale, timezone, model, capability block,
 * tool config and the 32-byte f15 device signature.
 */
function extractCaptured(parsedFetch) {
  const out = {}
  let buf = capturedBody(parsedFetch)
  if (!buf || buf.length === 0) return out
  if (buf.length >= 5 && buf[0] <= 3 && buf.readUInt32BE(1) === buf.length - 5) {
    buf = buf.subarray(5)
  }
  const get = (nodes, f) => nodes.find((n) => n.field === f && n.bytes)
  const top = rawFields(buf)
  const head = get(top, 1)
  const msg = get(top, 2)
  if (head) {
    const h = rawFields(head.bytes)
    const caps = get(h, 7)
    if (caps) out.caps = Buffer.from(caps.bytes)
    const sig = get(h, 15)
    if (sig && sig.bytes.length === 32) out.signature = Buffer.from(sig.bytes)
    const loc = get(h, 14)
    if (loc) out.locale = loc.bytes.toString('utf8')
  }
  if (msg) {
    const m = rawFields(msg.bytes)
    const tz = get(m, 12)
    if (tz) out.timezone = tz.bytes.toString('utf8')
    const loc = get(m, 13)
    if (loc) out.locale = loc.bytes.toString('utf8')
    const mdl = get(m, 7)
    const name = mdl && get(rawFields(mdl.bytes), 2)
    if (name) out.model = name.bytes.toString('utf8')
    const tools = get(m, 8)
    if (tools) out.toolConfig = Buffer.from(tools.bytes)
  }
  return out
}

/**
 * Accumulates raw stream chunks and emits whole Connect frames as they complete.
 * Handles frames split across chunk boundaries.
 * @returns {{push: (chunk: Buffer) => {flags: number, data: Buffer}[]}}
 */
function makeFrameReader() {
  let buf = Buffer.alloc(0)
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk])
      const out = []
      let off = 0
      while (off + 5 <= buf.length) {
        const flags = buf[off]
        const len = buf.readUInt32BE(off + 1)
        if (off + 5 + len > buf.length) break
        out.push({ flags, data: buf.subarray(off + 5, off + 5 + len) })
        off += 5 + len
      }
      buf = buf.subarray(off)
      return out
    },
  }
}

// ── timeline decode ─────────────────────────────────────────────────────────

/**
 * Flatten decoded StreamTimeline fields into content blocks.
 * Recovered shape (see providers/claude/api.md):
 *   dgrp_* (message group): f4 = role (1 human, 2 assistant), f5 = label
 *   cblk_* (content block): f5 = label ("Thought for 2s"), f9 = text,
 *                           f12 = reasoning text
 *
 * @param {object[]} nodes decoded proto fields (flat or nested)
 * @param {object[]} [out]
 * @returns {{kind: 'text'|'reasoning', text: string, id?: string}[]}
 */
function extractBlocks(nodes, out = []) {
  if (!Array.isArray(nodes)) return out
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    if (Array.isArray(n.value)) {
      extractBlocks(n.value, out)
      continue
    }
    if (typeof n.value !== 'string') continue
    if (n.value.startsWith('cblk_') && n.field === 1) {
      out.push({ kind: 'block', id: n.value })
    }
  }
  return out
}

/**
 * Walk decoded timeline fields and collect assistant text + reasoning in order.
 * Text blocks use field 9; reasoning blocks use field 12.
 *
 * @param {object[]} nodes
 * @returns {{text: string[], reasoning: string[]}}
 */
function collectContent(nodes) {
  const text = []
  const reasoning = []
  const visit = (arr) => {
    for (const n of arr) {
      if (!n || typeof n !== 'object') continue
      if (Array.isArray(n.value)) {
        visit(n.value)
        continue
      }
      if (typeof n.value !== 'string') continue
      if (n.field === 9) text.push(n.value)
      else if (n.field === 12) reasoning.push(n.value)
    }
  }
  visit(nodes)
  return { text, reasoning }
}

// ── client ──────────────────────────────────────────────────────────────────

// ── reply collector ─────────────────────────────────────────────────────────

/** Strip the 1-field wrapper (0x0a <len> <text>) the server puts around reasoning text. */
function unwrapText(s) {
  if (typeof s !== 'string' || s.charCodeAt(0) !== 10) return s
  const len = s.charCodeAt(1)
  if (len >= 0x80) return s
  const rest = s.slice(2)
  return Buffer.byteLength(rest) === len ? rest : s
}

/**
 * Stateful decoder for StreamTimeline frames (shape verified against HAR):
 *   inner f1  = snapshot: f3 messages {f1 id, f3 role 1=human 2=assistant},
 *               f4 groups {f1 id, f2 message id}, f5 blocks {f1 id, f2 group,
 *               f9 text, f12 reasoning}, f20 {f1 {f1 session, f2 seq}}
 *   inner f2  = delta: f1 block id, f2 text increment, f6 reasoning increment
 *   inner f4  = end-of-turn usage frame
 *   inner f10 = resume cursor {f1 '<ms>-<n>'}
 * Deltas are increments; the later snapshot repeats the full text, so output is
 * de-duplicated per block. Human messages are never emitted.
 * @returns {{state: object, feed: (proto: object[]) => {text: string[], reasoning: string[], done: boolean, sessionId: string|null, seq: number|null, cursor: string|null}}}
 */
function makeReplyCollector() {
  const msgRole = new Map()
  const groupMsg = new Map()
  const blocks = new Map()
  const state = { sessionId: null, seq: null, cursor: null }
  const get = (nodes, f) => {
    const n = nodes.find((x) => x.field === f)
    return n ? n.value : undefined
  }
  const str = (nodes, f) => {
    const v = get(nodes, f)
    return typeof v === 'string' ? v : undefined
  }
  const num = (nodes, f) => {
    const v = get(nodes, f)
    return typeof v === 'number' ? v : undefined
  }
  const block = (id) => {
    if (!blocks.has(id)) blocks.set(id, { group: null, text: '', reasoning: '' })
    return blocks.get(id)
  }
  const roleOf = (b) => msgRole.get(groupMsg.get(b.group))
  const sync = (b, kind, full, out) => {
    if (!full || full.length <= b[kind].length || !full.startsWith(b[kind])) return
    out[kind].push(full.slice(b[kind].length))
    b[kind] = full
  }
  return {
    state,
    feed(proto) {
      const out = { text: [], reasoning: [], done: false }
      const inner = proto[0] && Array.isArray(proto[0].value) ? proto[0].value : []
      const cur = get(inner, 10)
      if (Array.isArray(cur)) state.cursor = str(cur, 1) || state.cursor
      for (const n of inner) {
        if (!Array.isArray(n.value)) continue
        if (n.field === 4) {
          out.done = true
        } else if (n.field === 2) {
          const id = str(n.value, 1)
          if (!id) continue
          const b = block(id)
          if (roleOf(b) === 1) continue
          const t = str(n.value, 2)
          const r = unwrapText(str(n.value, 6))
          if (t) {
            b.text += t
            out.text.push(t)
          }
          if (r) {
            b.reasoning += r
            out.reasoning.push(r)
          }
        } else if (n.field === 1) {
          const sn = n.value
          for (const m of sn.filter((x) => x.field === 3 && Array.isArray(x.value))) {
            msgRole.set(str(m.value, 1), num(m.value, 3))
          }
          for (const g of sn.filter((x) => x.field === 4 && Array.isArray(x.value))) {
            groupMsg.set(str(g.value, 1), str(g.value, 2))
          }
          for (const bl of sn.filter((x) => x.field === 5 && Array.isArray(x.value))) {
            const b = block(str(bl.value, 1))
            b.group = str(bl.value, 2) || b.group
            if (roleOf(b) === 1) continue
            sync(b, 'text', str(bl.value, 9), out)
            sync(b, 'reasoning', unwrapText(str(bl.value, 12)), out)
          }
          const sess = get(sn, 20)
          const s1 = Array.isArray(sess) ? get(sess, 1) : undefined
          if (Array.isArray(s1)) {
            state.sessionId = str(s1, 1) || state.sessionId
            const sq = num(s1, 2)
            if (sq !== undefined) state.seq = sq
          }
        }
      }
      return Object.assign(out, state)
    },
  }
}

/**
 * Connect-RPC client for the current claude.ai web transport.
 *
 * Captures carry `x-organization-uuid` (not a URL org path), so the org id
 * comes from a header. The base class keeps the raw header map for exact-order
 * reconstruction, which Cloudflare fingerprints.
 */
class ClaudeConnectRpc extends BaseAPI {
  constructor(options = {}) {
    super(options)
    this._orgId = null
    this._deviceId = null
  }

  async initializeFromJSON(parsedFetch) {
    await super.initializeFromJSON(parsedFetch)
    const h = this._headers
    if (!h.cookie && !h.Cookie && this._log) {
      console.warn(
        '[Claude] WARNING: no cookie in capture — StreamTimeline will 403 at Cloudflare. Re-copy the request as fetch (includes cookie).',
      )
    }
    this._orgId =
      h['x-organization-uuid'] ||
      (parsedFetch.url || '').match(/\/organizations\/([a-f0-9-]{36})/i)?.[1] ||
      null
    this._deviceId =
      h['anthropic-device-id'] ||
      String(h.cookie || h.Cookie || '').match(/(?:^|;\s*)anthropic-device-id=([^;]+)/)?.[1] ||
      null
    // Everything reusable from the captured fetch body (exact bytes, base64-stored).
    this._captured = extractCaptured(parsedFetch)
  }

  /**
   * Verify the session. `/api/account_profile` is a plain REST GET, independent
   * of the RPC transport, so the wizard's live check works for RPC captures too.
   * @returns {Promise<object>} account profile
   */
  async getCurrentUser() {
    const src = this._headers
    const cookieStr = this._cookies.toString()
    const headers = {
      accept: '*/*',
      'accept-language': src['accept-language'] || 'en-US,en;q=0.9',
      'anthropic-client-platform': src['anthropic-client-platform'] || 'web_claude_ai',
      origin: 'https://claude.ai',
      referer: src['referer'] || 'https://claude.ai/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': src['user-agent'] || 'Mozilla/5.0',
    }
    if (src['anthropic-client-build'])
      headers['anthropic-client-build'] = src['anthropic-client-build']
    if (this._deviceId) headers['anthropic-device-id'] = this._deviceId
    if (cookieStr) headers.cookie = cookieStr

    const res = await this._fetch(
      'https://claude.ai/api/account_profile',
      { method: 'GET', headers },
      false,
    )
    this._captureResponseHeaders(res)
    await assertOk(res, { prefix: 'Failed to get account profile: ' })
    return res.json()
  }

  /**
   * Log every outgoing request (url, headers, body) before it is sent.
   * Cookie and authorization values are redacted to names/lengths only.
   */
  async _fetch(url, options = {}, ...rest) {
    try {
      const headers = {}
      for (const [k, v] of Object.entries(options.headers || {})) {
        const lower = k.toLowerCase()
        if (lower === 'cookie') {
          const names = String(v)
            .split(';')
            .map((c) => c.split('=')[0].trim())
            .filter(Boolean)
          headers[k] = `<redacted ${String(v).length} chars; cookies: ${names.join(',')}>`
        } else if (lower === 'authorization') {
          headers[k] = '<redacted>'
        } else {
          headers[k] = v
        }
      }
      const body = options.body
      let bodyInfo = 'none'
      if (Buffer.isBuffer(body)) {
        let decoded = ''
        try {
          const payload = body.length >= 5 && body[0] <= 3 ? body.subarray(5) : body
          decoded = JSON.stringify(walkProto(payload)).slice(0, 2000)
        } catch {
          decoded = '<undecodable>'
        }
        bodyInfo = `${body.length} bytes hex=${body.subarray(0, 96).toString('hex')} proto=${decoded}`
      } else if (body) {
        bodyInfo = String(body).slice(0, 2000)
      }
      console.debug(
        `[Claude] → ${options.method || 'GET'} ${url}\n  headers=${JSON.stringify(headers)}\n  body=${bodyInfo}`,
      )
    } catch (logErr) {
      console.error('request logging failed:', logErr)
    }
    return super._fetch(url, options, ...rest)
  }

  /** Case-insensitive header lookup over the captured headers. */
  _h(name) {
    const src = this._headers
    const lower = name.toLowerCase()
    for (const k of Object.keys(src)) {
      if (k.toLowerCase() === lower) return src[k]
    }
    return undefined
  }

  /** Build headers in the captured Connect-RPC shape. */
  _rpcHeaders(extra = {}) {
    const cookieStr = this._cookies.toString()
    const h = {
      accept: '*/*',
      'accept-language': this._h('accept-language') || 'en-US,en;q=0.9',
      'anthropic-client-platform': this._h('anthropic-client-platform') || 'web_claude_ai',
      'connect-protocol-version': CONNECT_PROTOCOL_VERSION,
      'content-type': CONNECT_CONTENT_TYPE,
      origin: 'https://claude.ai',
      priority: this._h('priority') || 'u=1, i',
      // Reuse the captured Referer verbatim (capital R in the HAR); falling back
      // to the site root breaks the CF same-origin check for an RPC call.
      referer: this._h('Referer') || this._h('referer') || 'https://claude.ai/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      // "Copy as fetch" omits user-agent; fall back to the Chrome build seen in the HAR.
      'user-agent':
        this._h('user-agent') ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      ...extra,
    }
    for (const name of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-gpc']) {
      const v = this._h(name)
      if (v) h[name] = v
    }
    const build = this._h('anthropic-client-build')
    const sha = this._h('anthropic-client-sha')
    if (build) h['anthropic-client-build'] = build
    if (sha) h['anthropic-client-sha'] = sha
    if (this._deviceId) h['anthropic-device-id'] = this._deviceId
    if (this._orgId) h['x-organization-uuid'] = this._orgId
    if (cookieStr) h.cookie = cookieStr
    return h
  }

  /**
   * Assert an RPC response is usable, with a clear error when Cloudflare served
   * its JS challenge ("Just a moment...") instead of the API. A challenge means
   * the node-fetch TLS fingerprint was rejected — retrying won't help; the
   * session needs to run through a real browser (or supply a fresh cf_clearance).
   */
  async _assertRpcOk(res) {
    if (res.ok) return
    const body = await res.text().catch(() => '')
    const hdr = (n) => res.headers.get(n) || ''
    const contentType = hdr('content-type')
    const meta = [
      `url=${res.url}`,
      `type=${contentType || 'none'}`,
      hdr('cf-ray') && `cf-ray=${hdr('cf-ray')}`,
      hdr('cf-mitigated') && `cf-mitigated=${hdr('cf-mitigated')}`,
      hdr('server') && `server=${hdr('server')}`,
      hdr('grpc-status') && `grpc-status=${hdr('grpc-status')}`,
      hdr('grpc-message') && `grpc-message=${hdr('grpc-message')}`,
    ]
      .filter(Boolean)
      .join(' ')
    let detail = body.slice(0, 1000)
    try {
      const json = JSON.parse(body)
      if (json && (json.code || json.message || json.error)) {
        const e = json.error || json
        detail = `${e.code || ''} ${e.message || ''} ${JSON.stringify(e.details || '')}`.trim()
      }
    } catch {
      // not JSON — keep the raw body slice
    }
    const challenge =
      /Just a moment|cf-chl|__cf_chl/i.test(body) || hdr('cf-mitigated') === 'challenge'
    const err = new Error(
      challenge
        ? `Cloudflare challenge (HTTP ${res.status}) — node-fetch fingerprint rejected. Use a real browser session or refresh cf_clearance. [${meta}]`
        : `HTTP ${res.status} ${res.statusText || ''}: ${detail} [${meta}]`,
    )
    err.status = res.status
    err.statusCode = res.status
    err.body = body.slice(0, 2000)
    throw err
  }

  /**
   * POST one Connect-RPC method. Connect-framed body, buffered response.
   * @param {string} method
   * @param {Buffer} payload protobuf body
   * @param {string} [conversationId] for the referer path
   * @returns {Promise<{frames: {flags: number, data: Buffer}[], res: object}>}
   */
  async _rpc(method, payload, conversationId = '') {
    const url = `${RPC_BASE}/${SERVICE}/${method}`
    const body = frame(payload)
    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._rpcHeaders({
          referer: conversationId
            ? `https://claude.ai/chat/${conversationId}`
            : 'https://claude.ai/',
          'content-length': String(body.length),
        }),
        body,
      },
      false,
    )
    this._captureResponseHeaders(res)
    await this._assertRpcOk(res)
    const buf = Buffer.from(await res.arrayBuffer())
    return { frames: unframe(buf), res }
  }

  /**
   * POST one REST protobuf method (application/proto, NO Connect framing).
   * Used by PerformAction and GetNewConversationDefaults.
   * @param {string} method
   * @param {Buffer} payload bare protobuf body
   * @param {string} [conversationId]
   * @returns {Promise<Buffer>} raw response bytes
   */
  async _proto(method, payload, conversationId = '', extra = {}) {
    const url = `${RPC_BASE}/${SERVICE}/${method}`
    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._rpcHeaders({
          'content-type': 'application/proto',
          ...extra,
          // HAR claude4: every call of a brand-new chat (before the first reopen) uses /new.
          referer: this._newChat
            ? 'https://claude.ai/new'
            : conversationId
              ? `https://claude.ai/chat/${conversationId}`
              : 'https://claude.ai/',
          'content-length': String(payload.length),
        }),
        body: payload,
      },
      false,
    )
    this._captureResponseHeaders(res)
    await this._assertRpcOk(res)
    return Buffer.from(await res.arrayBuffer())
  }

  /**
   * Open a LONG-LIVED StreamTimeline and read frames incrementally.
   *
   * The HAR shows one StreamTimeline held open across multiple user messages
   * (PerformAction sends, the open stream emits replies). This returns a
   * handle with `next()` (await the next decoded frame) and `close()`.
   *
   * @param {object} opts { conversationId, locale, timezone, signal }
   * @returns {Promise<{next: () => Promise<object|null>, close: () => void, conversationId: string}>}
   */
  async openTimeline({
    conversationId,
    locale,
    timezone,
    cursor,
    signal,
    collector: sharedCollector,
  } = {}) {
    const convId = conversationId || uuid()
    const payload = buildStreamTimeline({
      cursor,
      initial: !cursor && !!this._newChat,
      conversationId: convId,
      locale: locale || (this._headers['accept-language'] || '').split(',')[0] || 'en-US',
      timezone: timezone || 'UTC',
    })
    const url = `${RPC_BASE}/${SERVICE}/StreamTimeline`
    const body = frame(payload)

    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._rpcHeaders({
          referer: this._newChat ? 'https://claude.ai/new' : `https://claude.ai/chat/${convId}`,
          'connect-accept-encoding': 'gzip',
          'content-length': String(body.length),
        }),
        body,
        signal,
      },
      false,
    )
    this._captureResponseHeaders(res)
    await this._assertRpcOk(res)

    const reader = makeFrameReader()
    const collector = sharedCollector || makeReplyCollector()
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try {
        res.body.destroy()
      } catch {
        // already closed
      }
    }

    // node-fetch v2 body is a Node Readable; iterate it and emit whole frames.
    const iterator = res.body[Symbol.asyncIterator]()
    const pending = []
    const next = async () => {
      if (closed) return null
      for (;;) {
        if (pending.length > 0) {
          const f = pending.shift()
          if (f.flags & 0x02) {
            closed = true
            const end = endStreamError(f)
            if (end) throw end
            return null
          }
          const proto = walkProto(decompressFrame(f))
          return { frames: [f], proto, blocks: collector.feed(proto) }
        }
        const { done, value } = await iterator.next()
        if (done) {
          closed = true
          return null
        }
        if (value) {
          const frames = reader.push(Buffer.from(value))
          for (const f of frames) pending.push(f)
        }
      }
    }

    return { next, close, conversationId: convId, collector }
  }

  /**
   * Return the client's persistent timeline for a conversation, opening it on
   * first use and reusing it across turns (the HAR holds ONE StreamTimeline open
   * across many PerformAction messages). Reopens if the previous stream closed.
   *
   * @param {string} conversationId
   * @param {object} [opts] { locale, timezone }
   * @returns {Promise<object>} timeline handle ({next, close, conversationId})
   */
  async timeline(conversationId, opts = {}) {
    const id = conversationId || uuid()
    if (this._timeline && this._timelineId === id && !this._timelineClosed) {
      return this._timeline
    }
    const timeline = await this.openTimeline({ conversationId: id, ...opts })
    const originalClose = timeline.close
    timeline.close = () => {
      this._timelineClosed = true
      originalClose()
    }
    this._timeline = timeline
    this._timelineId = id
    this._timelineClosed = false
    return timeline
  }

  /**
   * Send an action (message) on a conversation. Bare protobuf (application/proto).
   * @param {object} opts { conversationId, actionPayload }
   * @returns {Promise<Buffer>} raw response bytes
   */
  async performAction({ conversationId, payload }) {
    return this._proto('PerformAction', payload, conversationId, {
      'anthropic-chat-conversation-uuid': conversationId,
    })
  }

  /** Fetch defaults for a new conversation (empty-body POST, bare protobuf). */
  async getNewConversationDefaults() {
    const buf = await this._proto('GetNewConversationDefaults', Buffer.alloc(0), '', {
      'connect-timeout-ms': '20000',
    })
    return walkProto(buf)
  }

  /**
   * One-shot convenience: open a timeline, send the message, read frames until
   * the stream closes, and return the collected text/reasoning. Long-lived
   * callers should use openTimeline() + performAction() to reuse one stream.
   *
   * @param {object} opts { conversationId, prompt, locale, timezone, signal }
   * @returns {Promise<{text: string[], reasoning: string[], conversationId: string}>}
   */
  async sendMessage({
    conversationId,
    prompt,
    model,
    locale,
    timezone,
    signal,
    onText,
    onReasoning,
  } = {}) {
    const convId = conversationId || uuid()
    const cap = this._captured || {}
    const loc = locale || cap.locale || (this._h('accept-language') || '').split(',')[0] || 'en-US'
    const tz = timezone || cap.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const useModel = model || cap.model
    if (!conversationId) {
      this._newChat = true
      await this.getNewConversationDefaults()
      await this.performAction({
        conversationId: convId,
        payload: buildPromptlessAction({
          conversationId: convId,
          locale: loc,
          timezone: tz,
          model: useModel,
        }),
      })
    }
    let timeline = await this.openTimeline({
      conversationId: convId,
      locale: loc,
      timezone: tz,
      signal,
    })
    const text = []
    const reasoning = []
    try {
      if (this._sessionConv !== convId) {
        this._sessionConv = convId
        this._sessionId = null
        this._seq = 0
      }
      // HAR: the stream announces the session id within its first frames, before the prompt.
      while (!this._sessionId) {
        const first = await timeline.next()
        if (!first) throw new Error('StreamTimeline closed before a session id was announced')
        if (first.blocks.sessionId) this._sessionId = first.blocks.sessionId
      }
      // Throws until actionSignature (f15) is solved, before anything is sent.
      const seq = (this._seq || 0) + 1
      await this.performAction({
        conversationId: convId,
        payload: buildPromptAction({
          conversationId: convId,
          sessionId: this._sessionId || '',
          seq,
          messageId: uuid(),
          replyId: uuid(),
          prompt,
          // HAR claude4: model + tool config ride only on the first message.
          model: seq === 1 ? useModel : undefined,
          signature: cap.signature,
          toolConfigRaw: cap.toolConfig,
          locale: loc,
          timezone: tz,
        }),
      })
      this._seq = seq
      let emptyReopens = 0
      for (;;) {
        const frame = await timeline.next()
        if (!frame) {
          // HAR claude4: the server closes StreamTimeline every few seconds and the
          // client reopens it with f2.f1 = last cursor. Resume with the shared collector.
          if (signal?.aborted || emptyReopens >= 5) break
          emptyReopens += 1
          await new Promise((r) => setTimeout(r, 300))
          this._newChat = false
          timeline.close()
          timeline = await this.openTimeline({
            conversationId: convId,
            locale: loc,
            timezone: tz,
            cursor: timeline.collector.state.cursor || undefined,
            collector: timeline.collector,
            signal,
          })
          continue
        }
        emptyReopens = 0
        for (const r of frame.blocks.reasoning) {
          reasoning.push(r)
          if (onReasoning) onReasoning(r)
        }
        for (const t of frame.blocks.text) {
          text.push(t)
          if (onText) onText(t)
        }
        if (frame.blocks.sessionId) this._sessionId = frame.blocks.sessionId
        if (frame.blocks.done) break
      }
    } finally {
      this._newChat = false
      timeline.close()
    }
    return { text, reasoning, conversationId: convId }
  }
}

module.exports = {
  ClaudeConnectRpc,
  endStreamError,
  extractCaptured,
  makeReplyCollector,
  extractBlocks,
  collectContent,
  buildPromptAction,
  buildPromptlessAction,
  actionSignature,
  buildStreamTimeline,
  walkProto,
  frame,
  unframe,
  makeFrameReader,
  decompressFrame,
  writeVarint,
  writeLenField,
  writeVarintField,
  readVarint,
  RPC_BASE,
  SERVICE,
  CONNECT_CONTENT_TYPE,
  CONNECT_PROTOCOL_VERSION,
}
