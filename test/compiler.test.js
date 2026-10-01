const { test } = require('node:test')
const assert = require('node:assert')

const ToolCompiler = require('../engine/compiler')
const SYNTAX = require('../engine/syntax')

const SEP = SYNTAX.SEP

function compile(ide) {
  return new ToolCompiler(ide, 'deepseek')
}

test('parse + emit round-trips a read tool to the surface native name', () => {
  const expected = {
    vscode: 'read_file',
    copilot: 'view',
    terax: 'read_file',
    opencode: 'read',
  }

  for (const [ide, native] of Object.entries(expected)) {
    const compiler = compile(ide)
    const internal = compiler.parse(`read${SEP}path=C:/x.txt`)
    const emitted = compiler.emit(internal, { todos: {} })
    assert.strictEqual(emitted.name, native, `${ide}: read → ${native}`)
  }
})

test('copilot emits view_range for ranged reads', () => {
  const compiler = compile('copilot')
  const internal = compiler.parse(`read${SEP}path=C:/x.txt${SEP}from=5${SEP}to=20`)
  const emitted = compiler.emit(internal, { todos: {} })
  assert.strictEqual(emitted.name, 'view')
  assert.deepStrictEqual(emitted.arguments.view_range, [5, 20])
})

test('copilot exposes browser tools pre-registered (no $browser trigger needed)', () => {
  const compiler = compile('copilot')
  const internal = compiler.parse(`open_browser_page${SEP}url=https://example.com`)
  const emitted = compiler.emit(internal, { todos: {} })
  assert.strictEqual(emitted.name, 'openBrowserPage')
  assert.strictEqual(emitted.arguments.url, 'https://example.com')
})

test('classic vscode browser tool keeps its native name', () => {
  const compiler = compile('vscode')
  const internal = compiler.parse(`open_browser_page${SEP}url=https://example.com`)
  const emitted = compiler.emit(internal, { todos: {} })
  assert.strictEqual(emitted.name, 'open_browser_page')
})

test('unknown tool throws a descriptive error', () => {
  const compiler = compile('vscode')
  assert.throws(() => compiler.parse('does_not_exist'), /Unknown tool/)
})

test('copilot todos emit constraint-valid SQL', () => {
  const compiler = compile('copilot')
  const internal = compiler.parse(`todos_add${SEP}id=1${SEP}title=Do thing${SEP}desc=the desc`)
  const emitted = compiler.emit(internal, { todos: {} })
  assert.strictEqual(emitted.name, 'sql')
  assert.match(emitted.arguments.query, /INSERT INTO todos/)
  assert.doesNotMatch(emitted.arguments.query, /'completed'/)
})
