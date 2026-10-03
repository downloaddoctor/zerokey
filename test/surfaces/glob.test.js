const { test } = require('node:test')
const assert = require('node:assert')
const ToolCompiler = require('../../engine/compiler')
const { SEP } = require('../../engine/syntax')

function compile(ide, str) {
  const c = new ToolCompiler(ide, 'chatgpt')
  const internal = c.parse(str)
  return c.emit(internal, { todos: {} })
}

test('glob dir= maps to opencode path', () => {
  const out = compile('opencode', `glob${SEP}dir=src${SEP}pattern=*.js`)
  assert.strictEqual(out.arguments.path, 'src')
  assert.strictEqual(out.arguments.pattern, '*.js')
})

test('glob dir= maps to copilot paths', () => {
  const out = compile('copilot', `glob${SEP}dir=src${SEP}pattern=*.js`)
  assert.strictEqual(out.arguments.paths, 'src')
  assert.strictEqual(out.arguments.pattern, '*.js')
})

test('glob dir= maps to terax root', () => {
  const out = compile('terax', `glob${SEP}dir=src${SEP}pattern=*.js`)
  assert.strictEqual(out.arguments.root, 'src')
  assert.strictEqual(out.arguments.pattern, '*.js')
})

test('glob dir= folds into vscode query', () => {
  const out = compile('vscode', `glob${SEP}dir=src${SEP}pattern=*.js`)
  assert.strictEqual(out.arguments.query, 'src/*.js')
})

test('glob pattern=src/utils falls back to dir', () => {
  const out = compile('opencode', `glob${SEP}pattern=src/utils`)
  assert.strictEqual(out.arguments.path, 'src/utils')
  assert.strictEqual(out.arguments.pattern, '**/*')
})

test('glob pattern=**/*.js does not fall back', () => {
  const out = compile('opencode', `glob${SEP}pattern=**/*.js`)
  assert.strictEqual(out.arguments.path, undefined)
  assert.strictEqual(out.arguments.pattern, '**/*.js')
})

test('glob pattern=src/*.js does not fall back (has glob chars)', () => {
  const out = compile('opencode', `glob${SEP}pattern=src/*.js`)
  assert.strictEqual(out.arguments.path, undefined)
  assert.strictEqual(out.arguments.pattern, 'src/*.js')
})
