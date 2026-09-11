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

if (failed) {
  console.error(`\n${failed} module(s) failed to load`)
  process.exit(1)
}

console.log(`OK: ${modules.length} modules loaded`)
