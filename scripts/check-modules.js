'use strict'

/**
 * Load every module under the active tree and assert the non-negotiable
 * invariants. Exits non-zero on any failure.
 *
 * Skipped on purpose:
 *   - ./utils/log is required twice (scheduleDailyReset runs at load), so it is
 *     required before anything else and its side effects are accepted.
 *   - core/state/db is required with an explicit file under temp/ so the gate
 *     test does not touch the real DATA_DIR.
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const DIRS = ['core', 'engine', 'routes', 'utils']

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const modules = DIRS.flatMap((d) => walk(path.join(root, d)))

let failed = 0
for (const mod of modules) {
  const rel = './' + path.relative(root, mod).split(path.sep).join('/')
  try {
    require(mod)
  } catch (err) {
    console.error(`FAIL: ${rel} — ${err.message}`)
    failed++
  }
}

const { CONFIG } = require('../config/constants')
const log = require('../utils/log')
const db = require('../core/state/db')
const sessions = require('../core/state/sessions')

function ok(label, condition, detail) {
  if (condition) return
  console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`)
  failed++
}

function eq(label, actual, expected) {
  ok(
    label,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

// --- non-negotiable invariants -------------------------------------------

eq('bind host is loopback', CONFIG.HOST, '127.0.0.1')
eq('default port', CONFIG.PORT, 7250)
eq('exact port is on by default', CONFIG.EXACT_PORT, true)
ok(
  'schema version is a positive integer',
  Number.isInteger(db.SCHEMA_VERSION) && db.SCHEMA_VERSION > 0,
)

const bearer = log.redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')
ok('bearer is redacted', !bearer.includes('abcdefghijkl'), bearer)
ok('bearer marker stays', bearer.includes('<redacted>'), bearer)

const jsonToken = log.redact('{"access":"abcdefghijklmnop","other":"visible"}')
ok('access field is redacted', !jsonToken.includes('abcdefghij'), jsonToken)
ok('other fields survive', jsonToken.includes('visible'), jsonToken)

const jwt = log.redact('token=eyJhbGciOiJIUzI1NiJ9.payload')
ok('jwt is redacted', !jwt.includes('payload'), jwt)

const dataUrl = log.redact('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg')
ok('data URL is redacted', !dataUrl.includes('iVBORw0KGgo'), dataUrl)
ok('data URL MIME stays', dataUrl.includes('data:image/png;base64,<redacted>'), dataUrl)

const sas = log.redact('https://x/y?sv=2024-11-04&se=2030-01-01&sig=topsecret')
ok('SAS signature is redacted', !sas.includes('topsecret'), sas)
ok('SAS query stays diagnosable', sas.includes('sig=<redacted>'), sas)

// --- state round-trip on a scratch database ------------------------------

function cleanupDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix
    if (!fs.existsSync(f)) continue
    try {
      fs.unlinkSync(f)
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err
    }
  }
}

const scratchDir = path.join(root, 'temp')
fs.mkdirSync(scratchDir, { recursive: true })
const scratch = path.join(scratchDir, 'check-modules-scratch.db')
cleanupDb(scratch)

try {
  const store = db.open({ file: scratch })
  const created = sessions.resolve(store, 'chatgpt', 'check-modules-session')
  ok('sessions.resolve returns a persistent row', created.persistent === true)
  ok('sessions.resolve creates a new row on first call', created.upstreamConversationId === null)

  sessions.save(store, {
    provider: 'chatgpt',
    id: created.id,
    upstreamConversationId: 'conv-check',
    upstreamParentMessageId: 'msg-check',
  })
  const loaded = sessions.get(store, 'chatgpt', 'check-modules-session')
  eq('sessions round-trip stores conversation id', loaded.upstreamConversationId, 'conv-check')
  eq('sessions round-trip stores parent id', loaded.upstreamParentMessageId, 'msg-check')

  const reset = sessions.resetUpstream(store, 'chatgpt', 'check-modules-session')
  eq('resetUpstream clears conversation id', reset.upstreamConversationId, null)
  eq('resetUpstream marks state', reset.state, 'rebased')

  db.setMeta(store, 'schema_version', db.SCHEMA_VERSION + 1)
  store.close()

  let rejected = false
  try {
    db.open({ file: scratch })
  } catch {
    rejected = true
  }
  ok('schema_version gate rejects a newer database', rejected)
} finally {
  cleanupDb(scratch)
}

// --- startup hygiene -----------------------------------------------------

const startSource = fs.readFileSync(path.join(root, 'scripts', 'start.js'), 'utf8')
ok('start uses wx lock acquisition', /fs\.openSync\(CONFIG\.LOCK_FILE, 'wx'\)/.test(startSource))
ok(
  'start verifies listener ownership before adopting health',
  startSource.includes('healthBelongsToThisInstance'),
)

// --- Unix-only assumptions in active code --------------------------------

const PATTERNS = [
  [/['"`]\/opt\//, 'absolute /opt path'],
  [/['"`]\/root\//, 'absolute /root path'],
  [/\/bin\/(?:ba)?sh/, 'shell from /bin'],
  [/\bchmod(?:Sync)?\s*\(/, 'chmod call'],
  [/\bchown(?:Sync)?\s*\(/, 'chown call'],
  [/\bmktemp\b/, 'mktemp call'],
]

const SELF = path.resolve(__filename)
const hits = []
for (const file of modules) {
  if (path.resolve(file) === SELF) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const [pattern, label] of PATTERNS) {
      if (pattern.test(line)) hits.push(`${path.relative(root, file)}:${index + 1} (${label})`)
    }
  })
}
ok('no Unix-only assumptions in active code', hits.length === 0, hits.join(', '))

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}

console.log(`OK: ${modules.length} modules loaded, invariants hold`)
