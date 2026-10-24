'use strict'

/**
 * Bundle seam. In the esbuild release bundle (scripts/build.mjs) the virtual
 * module 'zk-bundle' carries { assets, providers, surfaces }. From source it
 * does not exist, so everything is read from disk and registries scan folders.
 *
 * zk-bundle is loaded lazily: it requires every provider, which would create a
 * require cycle (log -> constants -> bundle -> providers -> log) at load time.
 */
const fs = require('fs')
const path = require('path')

// Replaced by esbuild `define` at build time; undefined when running from source.
const IS_BUNDLED = process.env.ZK_BUNDLED === '1'

// Project root: repo root from source, the folder holding server.js when bundled.
const ROOT = IS_BUNDLED ? __dirname : path.resolve(__dirname, '..')

let bundle = null
function load() {
  if (!IS_BUNDLED) return null
  // Assets and modules are separate virtual modules: assets have no requires, so
  // they stay safe to read while provider modules are still mid-load (cycle).
  if (!bundle) {
    bundle = {
      get assets() {
        return require('zk-assets')
      },
      get providers() {
        return require('zk-modules').providers
      },
      get surfaces() {
        return require('zk-modules').surfaces
      },
    }
  }
  return bundle
}

/** Read a project file by root-relative posix path ('engine/extra/agent.md'). */
function readAsset(relPath, encoding) {
  const b = load()
  if (b && Object.hasOwn(b.assets, relPath)) {
    const buf = Buffer.from(b.assets[relPath], 'base64')
    return encoding ? buf.toString(encoding) : buf
  }
  return fs.readFileSync(path.join(ROOT, relPath), encoding)
}

/** File names directly inside a root-relative folder, optionally by extension. */
function listAssets(dirRel, ext = '') {
  const b = load()
  if (b) {
    const prefix = dirRel + '/'
    return Object.keys(b.assets)
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length))
      .filter((n) => n.endsWith(ext))
  }
  return fs.readdirSync(path.join(ROOT, dirRel)).filter((n) => n.endsWith(ext))
}

/** Bundled provider/surface modules, or null when running from source. */
function bundled(kind) {
  const b = load()
  return b ? b[kind] : null
}

module.exports = { ROOT, readAsset, listAssets, bundled }
