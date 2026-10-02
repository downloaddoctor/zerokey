const { test } = require('node:test')
const assert = require('node:assert')
const ToolCompiler = require('../engine/compiler')
const { SEP } = require('../engine/syntax')

function compile(ide, str) {
  const c = new ToolCompiler(ide, 'chatgpt')
  const internal = c.parse(str)
  return c.emit(internal, { todos: {} })
}

// ── dir= scoping ─────────────────────────────────────────────────────────

test('grep dir= maps to opencode path', () => {
  const out = compile('opencode', `grep${SEP}query=TODO${SEP}dir=src`)
  assert.strictEqual(out.arguments.path, 'src')
  assert.strictEqual(out.arguments.pattern, 'TODO')
})

test('grep dir= maps to copilot paths', () => {
  const out = compile('copilot', `grep${SEP}query=TODO${SEP}dir=src`)
  assert.strictEqual(out.arguments.paths, 'src')
})

test('grep dir= maps to terax root', () => {
  const out = compile('terax', `grep${SEP}query=TODO${SEP}dir=src`)
  assert.strictEqual(out.arguments.root, 'src')
})

test('grep dir= folds into vscode includePattern', () => {
  const out = compile('vscode', `grep${SEP}query=TODO${SEP}dir=src`)
  assert.strictEqual(out.arguments.includePattern, 'src/**')
})

test('grep dir= + filter= folds into vscode includePattern', () => {
  const out = compile('vscode', `grep${SEP}query=TODO${SEP}dir=src${SEP}filter=*.js`)
  assert.strictEqual(out.arguments.includePattern, 'src/*.js')
})

// ── max= capping ─────────────────────────────────────────────────────────

test('glob max= maps to terax max_results', () => {
  const out = compile('terax', `glob${SEP}pattern=**/*.js${SEP}max=10`)
  assert.strictEqual(out.arguments.max_results, 10)
})

test('glob max= maps to vscode maxResults', () => {
  const out = compile('vscode', `glob${SEP}pattern=**/*.js${SEP}max=10`)
  assert.strictEqual(out.arguments.maxResults, 10)
})

test('grep max= maps to terax max_results', () => {
  const out = compile('terax', `grep${SEP}query=TODO${SEP}max=15`)
  assert.strictEqual(out.arguments.max_results, 15)
})

test('grep max= maps to vscode maxResults', () => {
  const out = compile('vscode', `grep${SEP}query=TODO${SEP}max=15`)
  assert.strictEqual(out.arguments.maxResults, 15)
})

// ── no-regression: dir absent means no scope ─────────────────────────────

test('grep without dir sends no scope field (opencode)', () => {
  const out = compile('opencode', `grep${SEP}query=TODO`)
  assert.strictEqual(out.arguments.path, undefined)
})

test('grep without dir/filter sends no includePattern (vscode)', () => {
  const out = compile('vscode', `grep${SEP}query=TODO`)
  assert.strictEqual(out.arguments.includePattern, undefined)
})
