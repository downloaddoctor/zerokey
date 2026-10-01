const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const DIRS = ['core', 'engine', 'routes', 'utils', 'surfaces']

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('every module under core/, engine/, routes/, utils/, surfaces/ loads without error', () => {
  const modules = DIRS.flatMap((d) => walk(path.join(root, d)))
  assert.ok(modules.length > 0, 'expected to find modules to load')

  const failures = []
  for (const mod of modules) {
    try {
      require(mod)
    } catch (err) {
      failures.push(`./${path.relative(root, mod).split(path.sep).join('/')} — ${err.message}`)
    }
  }

  assert.deepStrictEqual(failures, [], `module load failures:\n${failures.join('\n')}`)
})
