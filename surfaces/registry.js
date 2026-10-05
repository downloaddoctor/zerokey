const fs = require('fs')
const path = require('path')

const { IDEToolSurface } = require('./base')

// One folder per surface: surfaces/<name>/index.js (+ template.json capture).
// base.js, specs.js and registry.js are shared files, not surfaces.

/**
 * Auto-discovers and registers IDE tool surfaces.
 * Scans surfaces/<name>.js — one flat file per surface (unlike providers/, which
 * use one multi-file folder each). Each surface module exports a config function
 * `(t) => { t.ideName = '...'; t.tool(...); ... }`; the registry keys it by the
 * surface's declared ideName, falling back to the filename.
 */
class SurfaceRegistry {
  constructor() {
    this.surfaces = new Map()
    this._discovered = false
    this._resolved = new Map()
  }

  _ensureDiscovered() {
    if (this._discovered) return
    this._discovered = true
    this._autoDiscover()
  }

  _autoDiscover() {
    const dir = __dirname
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const filePath = path.join(dir, entry.name, 'index.js')
      if (!fs.existsSync(filePath)) continue
      try {
        const configure = require(filePath)
        const fn = configure.default || configure
        if (typeof fn !== 'function') continue

        // Key by the surface's declared ideName; fall back to the filename.
        const probe = new IDEToolSurface()
        fn(probe)
        const key = probe.ideName || entry.name

        this.surfaces.set(key, fn)
      } catch (error) {
        console.error(`[Surfaces] Failed to load ${entry.name}:`, error.message)
      }
    }
  }

  /** @returns {object|null} the resolved mapper for a surface key */
  get(name) {
    this._ensureDiscovered()
    if (this._resolved.has(name)) return this._resolved.get(name)

    const configure = this.surfaces.get(name)
    if (!configure) {
      throw new Error(
        `Unknown IDE surface: "${name}". Known surfaces: ${this.getNames().join(', ')}`,
      )
    }

    const surface = new IDEToolSurface()
    configure(surface)
    const resolved = surface.resolve()
    this._resolved.set(name, resolved)
    return resolved
  }

  getNames() {
    this._ensureDiscovered()
    return Array.from(this.surfaces.keys())
  }

  /**
   * Flags a configured surface declares (browserTools, toolNameVariant, …).
   * Used by server.js (valid IDE names) and engine/triggers.js (browser tools).
   * @param {string} name
   * @returns {IDEToolSurface|null}
   */
  getSurface(name) {
    this._ensureDiscovered()
    const configure = this.surfaces.get(name)
    if (!configure) return null

    const surface = new IDEToolSurface()
    configure(surface)
    return surface
  }

  /**
   * Decide which surface a request belongs to by asking every surface whether
   * the system prompt is its own (realSessionPrefix → isRealSession). The
   * Bearer header cannot distinguish surfaces that share one IDE (vscode vs
   * copilot both arrive as 'vscode').
   *
   * @param {Array} messages - req.body.messages
   * @returns {string|null} matched surface key, or null when none match
   */
  resolveSurface(messages) {
    this._ensureDiscovered()
    const content = messages && messages[0] && messages[0].content
    if (typeof content !== 'string') return null

    for (const [key, configure] of this.surfaces) {
      const surface = new IDEToolSurface()
      configure(surface)
      if (surface.isRealSession(content)) return key
    }

    return null
  }
}

const registry = new SurfaceRegistry()

module.exports = registry
module.exports.getIDEMapper = (ide) => registry.get(ide)
module.exports.SurfaceRegistry = SurfaceRegistry
