'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const policy = require('../../../core/mhi/path-policy')

const ROOT = path.resolve(__dirname, '..')
const SCRATCH = path.join(ROOT, 'temp', 'test', 'mhi-path-policy-scratch')

function ensure() {
  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'a.txt'), 'hello', 'utf8')
}

test('scope requires a rootPath', () => {
  assert.throws(
    () => policy.scope({ context: {} }),
    (e) => e.code === 'mhi_workspace_required',
  )
})

test('existingFile accepts a file inside the root', () => {
  ensure()
  const s = policy.scope({ context: { rootPath: SCRATCH } })
  assert.equal(s.existingFile(path.join(SCRATCH, 'a.txt')).relativePath, 'a.txt')
})

test('existingFile rejects a path outside the root', () => {
  ensure()
  const s = policy.scope({ context: { rootPath: SCRATCH } })
  assert.throws(
    () => s.existingFile(path.join(ROOT, 'package.json')),
    (e) => e.code === 'mhi_path_outside_workspace',
  )
})

test('existingFile rejects a relative path', () => {
  ensure()
  const s = policy.scope({ context: { rootPath: SCRATCH } })
  assert.throws(
    () => s.existingFile('a.txt'),
    (e) => e.code === 'mhi_path_not_absolute',
  )
})

test('assertWindowsSyntax refuses UNC paths', () => {
  const BS = String.fromCharCode(0x5c)
  assert.throws(
    () => policy.assertWindowsSyntax(BS + BS + 'server' + BS + 'share'),
    (e) => e.code === 'mhi_path_unc_forbidden',
  )
})

test('assertWindowsSyntax refuses ADS', () => {
  assert.throws(
    () => policy.assertWindowsSyntax('C:' + String.fromCharCode(0x5c) + 'file.txt:stream'),
    (e) => e.code === 'mhi_path_ads_forbidden',
  )
})

test('assertWindowsSyntax refuses a reserved device name', () => {
  assert.throws(
    () => policy.assertWindowsSyntax('C:' + String.fromCharCode(0x5c) + 'CON'),
    (e) => e.code === 'mhi_path_reserved',
  )
})

test('assertWindowsSyntax refuses a trailing-dot segment', () => {
  assert.throws(
    () =>
      policy.assertWindowsSyntax(
        'C:' + String.fromCharCode(0x5c) + 'foo.' + String.fromCharCode(0x5c) + 'bar',
      ),
    (e) => e.code === 'mhi_path_invalid',
  )
})

test('newFile accepts a nonexistent path inside the root', () => {
  ensure()
  const s = policy.scope({ context: { rootPath: SCRATCH } })
  assert.equal(s.newFile(path.join(SCRATCH, 'new.txt')).relativePath, 'new.txt')
})

test('newFile refuses an existing file', () => {
  ensure()
  const s = policy.scope({ context: { rootPath: SCRATCH } })
  assert.throws(
    () => s.newFile(path.join(SCRATCH, 'a.txt')),
    (e) => e.code === 'mhi_file_exists',
  )
})
