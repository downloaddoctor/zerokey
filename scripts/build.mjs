import { build } from 'esbuild'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'dist')
const posix = (p) => p.split(path.sep).join('/')

// Files read from disk at runtime; embedded so server.js stands alone.
const ASSET_FILES = [
  'openapi.json',
  'core/state/schema.sql',
  'providers/deepseek/wasm/sha3_wasm_bg.7b9ca65ddd.wasm',
]
const ASSET_DIRS = [['engine/extra', '.md']]

async function subdirs(dir) {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && existsSync(path.join(ROOT, dir, e.name, 'index.js')))
    .map((e) => e.name)
    .sort()
}

async function virtualBundle(kind) {
  const providers = (await subdirs('providers')).filter((n) => n !== 'base')
  const surfaces = await subdirs('surfaces')

  const assetPaths = [...ASSET_FILES]
  for (const [dir, ext] of ASSET_DIRS) {
    for (const name of await readdir(path.join(ROOT, dir))) {
      if (name.endsWith(ext)) assetPaths.push(dir + '/' + name)
    }
  }

  const assets = {}
  for (const rel of assetPaths) {
    assets[rel] = (await readFile(path.join(ROOT, rel))).toString('base64')
  }

  if (kind === 'assets') return 'module.exports = ' + JSON.stringify(assets) + ';'
  return [
    'module.exports = {',
    '  providers: [' +
      providers
        .map((n) => 'require(' + JSON.stringify('./providers/' + n + '/index.js') + ')')
        .join(', ') +
      '],',
    '  surfaces: [' +
      surfaces
        .map(
          (n) =>
            '[' +
            JSON.stringify(n) +
            ', require(' +
            JSON.stringify('./surfaces/' + n + '/index.js') +
            ')]',
        )
        .join(', ') +
      '],',
    '};',
  ].join('\n')
}

const zkBundlePlugin = {
  name: 'zk-bundle',
  setup(b) {
    b.onResolve({ filter: /^zk-(assets|modules)$/ }, (args) => ({
      path: args.path,
      namespace: 'zk-bundle',
    }))
    b.onLoad({ filter: /.*/, namespace: 'zk-bundle' }, async (args) => ({
      contents: await virtualBundle(args.path === 'zk-assets' ? 'assets' : 'modules'),
      loader: 'js',
      resolveDir: ROOT,
    }))
  },
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

// 1. bundle our own code into one server.js; every npm package stays external
await build({
  entryPoints: [path.join(ROOT, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  minify: false,
  keepNames: true,
  define: { 'process.env.ZK_BUNDLED': '"1"' },
  legalComments: 'none',
  outfile: path.join(OUT, 'server.js'),
  plugins: [zkBundlePlugin],
  logLevel: 'info',
})

// 2. package.json: runtime fields only
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const slim = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  main: 'server.js',
  scripts: { start: 'node server.js' },
  packageManager: pkg.packageManager,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
}
await writeFile(path.join(OUT, 'package.json'), JSON.stringify(slim, null, 2) + '\n')

// 3. lockfile + workspace config (overrides) so pnpm resolves the same versions
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  if (existsSync(path.join(ROOT, f))) await copyFile(path.join(ROOT, f), path.join(OUT, f))
}

console.log('dist ready: ' + posix(path.relative(ROOT, OUT)))
