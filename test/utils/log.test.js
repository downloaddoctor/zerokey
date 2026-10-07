'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { SEP } = require('../../engine/syntax')

const LOG_MODULE = path.resolve(__dirname, '..', '..', 'utils', 'log.js')
const HEADER = [
  'ts',
  'pid',
  'level',
  'tag',
  'msg',
  'where',
  'error',
  'code',
  'status',
  'context',
  'stack',
].join(SEP)

// Runs the logger in a child process with an isolated data dir and returns
// the lines it wrote, so only the public console.* surface is exercised.
function runLogger(statements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerokey-log-'))
  try {
    const script = ['require(' + JSON.stringify(LOG_MODULE) + ')', ...statements].join(';')
    const res = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, ZEROKEY_DATA_DIR: dir, ZEROKEY_LOG_LEVEL: 'log' },
      encoding: 'utf8',
    })
    const file = path.join(dir, 'logs', 'zerokey.log')
    const lines = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      : []
    return { status: res.status, lines, stderr: res.stderr }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('log file starts with the SEP header and keeps one record per line', () => {
  const { status, lines, stderr } = runLogger([
    'console.log("plain, with comma")',
    'console.error("[T] boom", new Error("a" + String.fromCharCode(10) + "b"))',
  ])
  assert.strictEqual(status, 0, stderr)
  assert.strictEqual(lines[0], HEADER)
  assert.strictEqual(lines.length, 3)
})

test('commas are plain text; only SEP and double quotes force quoting', () => {
  const { lines } = runLogger(['console.log("plain, with comma")'])
  assert.ok(lines[1].includes(SEP + 'LOG' + SEP))
  assert.ok(lines[1].includes(SEP + 'plain, with comma' + SEP))
})

test('console.error with an Error writes one redacted row with merged context', () => {
  const { lines } = runLogger([
    'console.error("[T] boom happened", new Error("bad"), { token: "abc12345secret", id: 7 })',
  ])
  const row = lines[1]
  assert.ok(row.includes(SEP + 'ERROR' + SEP + 'T' + SEP + 'boom happened' + SEP))
  assert.ok(!row.includes('abc12345secret'))
  assert.ok(row.includes('"{""token"":""<redacted>"",""id"":7}"'))
})

test('extra console.error args are kept instead of dropped', () => {
  const { lines } = runLogger(['console.error("[T] msg", new Error("x"), "second", 42)'])
  assert.ok(lines[1].includes('second'))
  assert.ok(lines[1].includes('42'))
})

test('plain and error rows both carry the pid in the same column', () => {
  const { lines } = runLogger([
    'console.log("plain row")',
    'console.error("[T] boom", new Error("bad"))',
  ])
  const columns = HEADER.split(SEP)
  for (const row of lines.slice(1)) {
    const fields = row.split(SEP)
    assert.strictEqual(fields.length, columns.length, row)
    assert.match(fields[1], /^\d+$/, row)
  }
})

test('a circular cause does not crash the logger', () => {
  const { status, lines } = runLogger([
    'const e = new Error("loop")',
    'e.cause = e',
    'console.error("[T] loop", e)',
  ])
  assert.strictEqual(status, 0)
  assert.strictEqual(lines.length, 2)
})
