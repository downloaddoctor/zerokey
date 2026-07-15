'use strict'

const crypto = require('crypto')

/**
 * Hash a tools array from req.body.tools[] deterministically.
 * @param {Array} tools
 * @returns {string} hex digest
 */
function hashTools(tools) {
  return crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex')
}

/**
 * Build a grammar hint string from an MCP tool definition.
 * Supports OpenAI-style function schemas (input_schema / parameters).
 *
 * @param {object} tool  — one entry from req.body.tools[]
 * @returns {string}     — e.g. "query={str}|(limit={int})?"
 */
function grammarFromSchema(tool) {
  const schema = tool.input_schema || tool.function?.parameters || tool.parameters || {}

  const props = schema.properties || {}
  const required = new Set(schema.required || [])

  const parts = Object.entries(props).map(([key, def]) => {
    const type =
      def.type === 'integer' || def.type === 'number'
        ? 'int'
        : def.type === 'boolean'
          ? 'bool'
          : 'str'
    const hint = `${key}={${type}}`
    return required.has(key) ? hint : `(${hint})?`
  })

  return parts.join('|') || '{...}'
}

/**
 * Given the raw req.body.tools[], a reverseMap from getIDEMapper, and
 * the compiler's current this.tools object, sync dynamic MCP tools.
 *
 * Returns { changed, hash, dynamicGrammar }
 *   changed       — true if tools array hash differs from session.dynamicToolsHash
 *   hash          — new hash string
 *   dynamicGrammar — grammar block to inject into buildPrompt (empty string if none)
 *
 * Side-effect: registers / replaces passthrough entries in compiler.tools for
 * every non-inbuilt tool found in reqTools.
 *
 * @param {Array}  reqTools      req.body.tools[]
 * @param {object} session       current session object (read/write .dynamicToolsHash)
 * @param {object} compilerTools compiler.tools (mutated in-place)
 * @param {object} reverseMap    from getIDEMapper — IDE tool name → generic name
 * @returns {{ changed: boolean, hash: string, dynamicGrammar: string }}
 */
function syncDynamicTools(reqTools, session, compilerTools, reverseMap) {
  if (!Array.isArray(reqTools) || reqTools.length === 0) {
    return { changed: false, hash: session.dynamicToolsHash || null, dynamicGrammar: '' }
  }

  const hash = hashTools(reqTools)
  const changed = hash !== session.dynamicToolsHash

  return { changed: false, hash, dynamicGrammar: '' }

  if (!changed) {
    // Re-use previously generated grammar from session cache
    return { changed: false, hash, dynamicGrammar: session._dynamicGrammarCache || '' }
  }

  // --- Changed: rebuild ---

  // Collect inbuilt generic names + all known IDE tool names
  const inbuiltGeneric = new Set(Object.keys(compilerTools))
  // reverseMap keys are IDE tool names; values are generic names
  const inbuiltIDE = new Set(Object.keys(reverseMap))

  // Remove any previously registered dynamic entries (not in inbuilt set)
  for (const key of Object.keys(compilerTools)) {
    if (!inbuiltGeneric.has(key)) {
      delete compilerTools[key]
      console.warn(`[DynamicTools] Overwriting tool: ${key}`)
    }
  }

  // But we need the snapshot of inbuilts BEFORE we start adding dynamics,
  // so capture it once more cleanly:
  const staticKeys = new Set(Object.keys(compilerTools))

  const grammarLines = []

  for (const tool of reqTools) {
    // Normalise name — works for both OpenAI {type:'function', function:{name}} and raw {name}
    const rawName = tool.function?.name || tool.name
    if (!rawName) continue

    // Skip if this is an inbuilt (by generic name or IDE name)
    if (staticKeys.has(rawName) || inbuiltIDE.has(rawName)) continue

    const description = (tool.function && tool.function.description) || tool.description || rawName
    const grammar = grammarFromSchema(tool)

    // Build valid keys set from schema for strict param filtering in parse()
    const schema = tool.input_schema || tool.function?.parameters || tool.parameters || {}
    const validKeys = new Set(Object.keys(schema.properties || {}))

    // Register passthrough entry into compiler.tools
    compilerTools[rawName] = {
      _passthrough: true,
      _validKeys: validKeys,
      tool: rawName,
      params: {},
      keys: {},
      transformer: () => {},
      transform: () => {},
      default: {},
      repeatable: null,
      array: null,
      split: false,
    }

    grammarLines.push(`${rawName}: ${description}\n  grammar: ${grammar}`)
  }

  const dynamicGrammar =
    grammarLines.length > 0 ? '\n\n## MCP Tools\n' + grammarLines.join('\n\n') : ''

  // Store only hash on session (no tool objects — too large / unserializable)
  session.dynamicToolsHash = hash
  // Cache grammar on session for reuse when the tools hash is unchanged.
  // NOTE: this is currently written to users.json as-is by SessionSelector._saveUser
  // (no field-level exclusion there), so it does add to file size. It's fully
  // reconstructable from req.body.tools[] on the next hash match if that becomes
  // a problem worth trimming.
  session._dynamicGrammarCache = dynamicGrammar

  console.log(`[DynamicTools] Synced ${grammarLines.length} MCP tool(s)`)

  return { changed: true, hash, dynamicGrammar: ' ' }
}

module.exports = { syncDynamicTools, hashTools, grammarFromSchema }
