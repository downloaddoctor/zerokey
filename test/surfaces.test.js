const { test } = require('node:test')
const assert = require('node:assert')

const registry = require('../surfaces/registry')

test('registry auto-discovers the known surfaces', () => {
  const names = registry.getNames()
  for (const expected of ['vscode', 'copilot', 'terax', 'opencode']) {
    assert.ok(names.includes(expected), `missing surface: ${expected}`)
  }
})

test('every surface resolves tools with a native name and the required mapping shape', () => {
  for (const name of registry.getNames()) {
    const { tools, reverseMap, rawUser, system, user, tool } = registry.get(name)

    assert.ok(Object.keys(tools).length > 0, `${name}: no tools`)
    assert.strictEqual(typeof rawUser, 'function', `${name}: rawUser`)
    assert.strictEqual(typeof system, 'function', `${name}: system`)
    assert.strictEqual(typeof user, 'function', `${name}: user`)
    assert.strictEqual(typeof tool, 'function', `${name}: tool`)
    assert.ok(reverseMap && typeof reverseMap === 'object', `${name}: reverseMap`)

    for (const [generic, cfg] of Object.entries(tools)) {
      assert.strictEqual(
        typeof cfg.tool,
        'string',
        `${name}.${generic}: tool name must be a string`,
      )
      assert.ok(cfg.tool.length > 0, `${name}.${generic}: empty tool name`)
      assert.ok(cfg.default && typeof cfg.default === 'object', `${name}.${generic}: default`)
      assert.strictEqual(typeof cfg.transform, 'function', `${name}.${generic}: transform`)
      assert.strictEqual(typeof cfg.transformer, 'function', `${name}.${generic}: transformer`)
    }
  }
})

test('surface-specific native tool names are correct', () => {
  const expect = {
    vscode: { read: 'read_file', cmd: 'run_in_terminal', todos_add: 'manage_todo_list' },
    copilot: { read: 'view', cmd: 'powershell', todos_add: 'sql' },
    terax: { read: 'read_file', cmd: 'bash_run', todos_add: 'todo_write' },
    opencode: { read: 'read', cmd: 'bash', todos_add: 'todowrite' },
  }

  for (const [name, tools] of Object.entries(expect)) {
    const resolved = registry.get(name)
    for (const [generic, native] of Object.entries(tools)) {
      assert.strictEqual(
        resolved.tools[generic].tool,
        native,
        `${name}: ${generic} should map to ${native}`,
      )
    }
  }
})

test('vscode owns verbose output formatters; other surfaces pass through', () => {
  const vscode = registry.getSurface('vscode')
  assert.strictEqual(typeof vscode.formatters.write, 'function')
  assert.strictEqual(typeof vscode.formatters.replace, 'function')
  assert.strictEqual(typeof vscode.formatters.cmd, 'function')

  for (const name of ['copilot', 'terax', 'opencode']) {
    const surface = registry.getSurface(name)
    assert.deepStrictEqual(surface.formatters, {}, `${name} should have no formatters`)
  }
})

test('isRealSession matches only the surface that owns the prefix', () => {
  const samples = {
    vscode: 'You are an expert AI programming assistant. Help.',
    copilot: 'Follow Microsoft content policies. Avoid content...',
    terax: 'You are Terax, an AI agent.',
    opencode: 'You are opencode',
  }

  for (const [owner, content] of Object.entries(samples)) {
    for (const name of registry.getNames()) {
      const surface = registry.getSurface(name)
      assert.strictEqual(
        surface.isRealSession(content),
        name === owner,
        `${name}.isRealSession should ${name === owner ? '' : 'not '}match the ${owner} prompt`,
      )
    }
  }
})
