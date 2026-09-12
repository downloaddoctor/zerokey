/**
 * Auto-generate per-server MCP alias maps (same shape as hand-written maps
 * like ./browser.js) from req.body.tools[] using a mcp_<server>_<toolname>
 * naming convention. Lets any MCP server exposed this way be triggered with
 * $<server> without a hand-written alias file. Tools that don't follow the
 * convention fall under a $native tag instead of being dropped, with their
 * tool names prefixed 'native_' to avoid colliding with real inbuilt tools.
 */

const crypto = require('crypto')
const SYNTAX = require('../syntax')

/**
 * Hash a tools array (req.body.tools[]) deterministically, for cheap
 * per-session change detection.
 *
 * @param {Array} tools
 * @returns {string} hex digest
 */
function hashTools(tools) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(tools || []))
    .digest('hex')
}

/**
 * Group MCP tool schemas by server, inferred from the mcp_<server>_<toolname>
 * naming convention used to send MCP-bridged tools. Any tool that doesn't match
 * that convention is grouped under a 'native' key instead of being dropped —
 * its toolName is prefixed with 'native_' so it can never collide with a real
 * inbuilt tool name once injected via injectMcpAliases.
 *
 * @param {Array} tools - req.body.tools[] (OpenAI-style function schemas)
 * @returns {Object<string, Array>} server -> array of { rawName, toolName, tool }
 */
function groupToolsByServer(tools) {
  const groups = {}

  for (const tool of tools) {
    const rawName = tool.function?.name || tool.name
    if (!rawName) continue

    const match = /^mcp_([a-z0-9]+)_(.+)$/i.exec(rawName)

    const key = match ? match[1].toLowerCase() : 'native'
    const toolName = match ? match[2] : `native_${rawName}`

    if (!groups[key]) groups[key] = []
    groups[key].push({ rawName, toolName, tool })
  }

  return groups
}

/**
 * Build a block syntax param fragment from a JSON-schema tool definition,
 * e.g. "|target={str}(|element={str})?" from { target: required, element: optional }
 *
 * @param {object} tool
 * @returns {string}
 */
function buildParamSyntax(tool) {
  const schema = tool.input_schema || tool.function?.parameters || tool.parameters || {}
  const props = schema.properties || {}
  const required = new Set(schema.required || [])

  const entries = Object.entries(props)
  if (entries.length === 0) {
    return SYNTAX.SEP + 'call={true}'
  }

  return entries
    .map(([key, def]) => {
      const type =
        def.type === 'integer' || def.type === 'number'
          ? 'int'
          : def.type === 'boolean'
            ? 'bool'
            : def.type === 'array' || def.type === 'object'
              ? 'json'
              : 'str'
      const hint = `${key}={${type}}`
      return required.has(key) ? `${SYNTAX.SEP}${hint}` : `(${SYNTAX.SEP}${hint})?`
    })
    .join('')
}

/**
 * Build { '$server': aliasMap } for every server found in req.body.tools[],
 * shaped identically to hand-written maps (e.g. mcp/browser.js) so they can
 * be injected via injectMcpAliases and triggered with $<server>.
 *
 * @param {Array} tools - req.body.tools[]
 * @returns {Object<string, Object>}
 */
function buildAutoAliasMaps(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return {}

  const groups = groupToolsByServer(tools)
  const result = {}

  for (const [server, entries] of Object.entries(groups)) {
    const aliasMap = {}

    for (const { rawName, toolName, tool } of entries) {
      const desc = tool.function?.description || tool.description || ''
      const paramSyntax = buildParamSyntax(tool)
      const suffix = desc ? ' - ' + desc : ''
      aliasMap[toolName] = [rawName, SYNTAX.OPEN + toolName + paramSyntax + SYNTAX.CLOSE + suffix]
    }

    result[`$${server}`] = aliasMap
  }

  return result
}

module.exports = { groupToolsByServer, buildParamSyntax, buildAutoAliasMaps, hashTools }
