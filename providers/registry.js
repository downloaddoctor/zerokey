const fs = require('fs')
const path = require('path')

/**
 * Auto-discovers and registers provider plugins.
 * Scans providers/<name>/index.js folders.
 */
class ProviderRegistry {
  constructor() {
    this.providers = new Map()
    this._discovered = false
  }

  _ensureDiscovered() {
    if (this._discovered) return
    this._discovered = true
    this._autoDiscover()
  }

  _autoDiscover() {
    const providersDir = __dirname

    if (!fs.existsSync(providersDir)) {
      console.warn(`[Registry] Providers directory not found: ${providersDir}`)
      return
    }

    const entries = fs.readdirSync(providersDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'base') continue

      const indexPath = path.join(providersDir, entry.name, 'index.js')
      if (!fs.existsSync(indexPath)) continue

      try {
        const provider = require(indexPath)
        const providerDef = provider.default || provider

        if (providerDef && providerDef.name) {
          this.providers.set(providerDef.name, providerDef)
        }
      } catch (error) {
        console.error('require() failed:', error)
        console.error(`[Registry] Failed to load ${entry.name}:`, error.message)
      }
    }
  }

  get(name) {
    this._ensureDiscovered()
    return this.providers.get(name)
  }

  getAll() {
    this._ensureDiscovered()
    return Array.from(this.providers.values())
  }

  getNames() {
    this._ensureDiscovered()
    return Array.from(this.providers.keys())
  }

  getModels() {
    this._ensureDiscovered()
    const allModels = {}
    for (const provider of this.providers.values()) {
      if (!provider.models) continue
      const { owned_by, models } = provider.models
      for (const meta of Object.values(models)) {
        allModels[meta.id] = {
          id: meta.id,
          name: meta.name,
          object: 'model',
          created: meta.created,
          owned_by,
          context_length: meta.context_length,
          max_output_length: meta.max_output_length,
        }
      }
    }
    return allModels
  }
}

module.exports = new ProviderRegistry()
