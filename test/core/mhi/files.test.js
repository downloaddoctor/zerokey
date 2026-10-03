'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const files = require('../../../core/mhi/files')

const ROOT = path.resolve(__dirname, '..')
const SCRATCH = path.join(ROOT, 'temp', 'test', 'mhi-files-scratch')

function reset() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'a.txt'), 'line1\nline2\nline3\n', 'utf8')
  fs.mkdirSync(path.join(SCRATCH, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'sub', 'b.txt'), 'needle here\n', 'utf8')
}

function ctx() {
  return { context: { rootPath: SCRATCH, cwd: SCRATCH } }
}

test('read returns line-numbered content', async () => {
  reset()
  const result = await files.execute(
    { tool: 'read', params: { path: path.join(SCRATCH, 'a.txt') } },
    ctx(),
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /1: line1/)
  assert.match(result.output, /3: line3/)
})

test('read honours from/to', async () => {
  reset()
  const result = await files.execute(
    { tool: 'read', params: { path: path.join(SCRATCH, 'a.txt'), from: 2, to: 2 } },
    ctx(),
  )
  assert.match(result.output, /2: line2/)
  assert.doesNotMatch(result.output, /1: line1/)
})

test('write creates new files only', async () => {
  reset()
  const first = await files.execute(
    { tool: 'write', params: { path: path.join(SCRATCH, 'new.txt'), content: 'hi' } },
    ctx(),
  )
  assert.equal(first.ok, true)
  const second = await files.execute(
    { tool: 'write', params: { path: path.join(SCRATCH, 'new.txt'), content: 'again' } },
    ctx(),
  )
  assert.equal(second.ok, false)
  assert.equal(second.code, 'mhi_file_exists')
})

test('replace swaps exactly one match', async () => {
  reset()
  const result = await files.execute(
    { tool: 'replace', params: { path: path.join(SCRATCH, 'a.txt'), old: 'line2', new: 'LINE2' } },
    ctx(),
  )
  assert.equal(result.ok, true)
  assert.match(fs.readFileSync(path.join(SCRATCH, 'a.txt'), 'utf8'), /LINE2/)
})

test('replace refuses ambiguous matches', async () => {
  reset()
  fs.writeFileSync(path.join(SCRATCH, 'dup.txt'), 'x\nx\n', 'utf8')
  const result = await files.execute(
    { tool: 'replace', params: { path: path.join(SCRATCH, 'dup.txt'), old: 'x', new: 'y' } },
    ctx(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mhi_replace_not_unique')
})

test('replace refuses a missing match', async () => {
  reset()
  const result = await files.execute(
    { tool: 'replace', params: { path: path.join(SCRATCH, 'a.txt'), old: 'nope', new: 'y' } },
    ctx(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mhi_replace_not_found')
})

test('grep finds a needle', async () => {
  reset()
  const result = await files.execute({ tool: 'grep', params: { query: 'needle' } }, ctx())
  assert.equal(result.ok, true)
  assert.match(result.output, /sub\/b\.txt:1/)
})

test('grep with a glob filter narrows', async () => {
  reset()
  const result = await files.execute(
    { tool: 'grep', params: { query: 'line', glob: '*.txt' } },
    ctx(),
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /a\.txt/)
  assert.doesNotMatch(result.output, /b\.txt/)
})

test('ls lists a directory', async () => {
  reset()
  const result = await files.execute({ tool: 'ls', params: { path: SCRATCH } }, ctx())
  assert.equal(result.ok, true)
  assert.match(result.output, /a\.txt/)
  assert.match(result.output, /sub\//)
})

test('glob matches a pattern', async () => {
  reset()
  const result = await files.execute({ tool: 'glob', params: { pattern: '**/*.txt' } }, ctx())
  assert.equal(result.ok, true)
  assert.match(result.output, /a\.txt/)
  assert.match(result.output, /sub\/b\.txt/)
})

test('read rejects a path outside the root', async () => {
  reset()
  const result = await files.execute(
    { tool: 'read', params: { path: path.join(ROOT, 'package.json') } },
    ctx(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mhi_path_outside_workspace')
})

test('aborted signal rejects execution', async () => {
  reset()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    files.execute(
      { tool: 'read', params: { path: path.join(SCRATCH, 'a.txt') } },
      { ...ctx(), signal: controller.signal },
    ),
    (e) => e.name === 'AbortError',
  )
})
