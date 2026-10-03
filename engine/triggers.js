const fs = require('fs')
const path = require('path')
const SYNTAX = require('./syntax')
const { injectMcpAliases } = require('./mcp/inject')
const { buildAutoAliasMaps, hashTools } = require('./mcp/auto')
const { captureRequest } = require('../utils/capture-request')
const instructions = require('./instructions')

const BROWSER_MCP = require('./mcp/browser')
const PLAYWRIGHT_MCP = require('./mcp/playwright')

// $test scratch root: always the server's own cwd + /test, regardless of
// where the request came from — never user-supplied.
const TEST_ROOT = path.join(__dirname, '..')

// Alias-map registry keyed by the same tag used in session.mcpInjected.
const MCP_ALIAS_MAPS = { $browser: BROWSER_MCP, $playwright: PLAYWRIGHT_MCP }

// Live probe map: tag -> first toolName in its alias map, used as a cheap
// "is this alias map already registered on this compiler?" probe. Updated
// whenever MCP_ALIAS_MAPS gains or loses a key.
const MCP_ALIAS_PROBE_KEY = {}

function _syncProbeKey(tag) {
  const aliasMap = MCP_ALIAS_MAPS[tag]
  if (aliasMap) MCP_ALIAS_PROBE_KEY[tag] = Object.keys(aliasMap)[0]
  else delete MCP_ALIAS_PROBE_KEY[tag]
}
// Seed from initial static maps.
for (const tag of Object.keys(MCP_ALIAS_MAPS)) _syncProbeKey(tag)

function markMcpInjected(session, tag) {
  if (!session) return
  if (!session.mcpInjected || typeof session.mcpInjected !== 'object') session.mcpInjected = {}
  session.mcpInjected[tag] = true
}

/**
 * Register any MCP servers found in req.body.tools[] (via the mcp_<server>_<tool>
 * naming convention) into MCP_ALIAS_MAPS under their own '$<server>' tag, so
 * they become triggerable the same way as hand-written maps like $browser.
 * Hand-written maps always win — auto-generated entries never overwrite them.
 *
 * Also hashes reqTools and compares against session.dynamicToolsHash for cheap
 * per-session change detection — this replaces the old dynamic-tools.js module,
 * since the MCP layer is the only thing that actually knows which of these
 * tools belong to it.
 *
 * @param {Array} reqTools - req.body.tools[]
 * @param {object} [session] - current session (read/write .dynamicToolsHash)
 * @returns {{ changed: boolean, hash: string|null }}
 */
function registerAutoMcpServers(reqTools, session) {
  if (!Array.isArray(reqTools) || reqTools.length === 0) {
    return { changed: false, hash: session?.dynamicToolsHash || null }
  }

  const hash = hashTools(reqTools)
  const changed = hash !== session?.dynamicToolsHash
  if (session) session.dynamicToolsHash = hash

  const autoMaps = buildAutoAliasMaps(reqTools)
  for (const [tag, aliasMap] of Object.entries(autoMaps)) {
    if (!MCP_ALIAS_MAPS[tag]) {
      MCP_ALIAS_MAPS[tag] = aliasMap
      _syncProbeKey(tag)
    }
  }

  return { changed, hash }
}

/**
 * Shared passthrough call used by every MCP-triggering skill ($browser and
 * any auto-registered $<server> tag): injects the tag's alias map into the
 * compiler's tool table, strips the trigger word from the triggering message,
 * and splices a <${SYNTAX.xNAME}_list> grammar block in as a preceding INTERNAL message.
 *
 * @param {string} tag - e.g. '$browser' or an auto-registered '$<server>'
 */
function makePassthroughMcpCall(tag) {
  return ({ messages, index, compilerTools, parser }) => {
    // Only surfaces that declare browserTools get $browser/$playwright — others
    // silently no-op rather than injecting grammar they cannot execute. The
    // surface also declares which tool-name variant to emit.
    const surfaceDef = parser?.compiler?.surfaceDef
    if (!surfaceDef?.browserTools) return

    const aliasMap = MCP_ALIAS_MAPS[tag]
    const grammar = injectMcpAliases(aliasMap, compilerTools, surfaceDef.browserNameMap)
    // const message = messages[index]
    // message.content = message.content.replace(tag, '').trim()
    messages.splice(index, 1, {
      role: 'live_instructions',
      content: `<${SYNTAX.xNAME}_list title="${tag.slice(1)} tools">\n${grammar}\n</${SYNTAX.xNAME}_list>`,
    })
    markMcpInjected(parser?.session, tag)
  }
}

// Generic passthrough: splice engine/extra/<name>.md into the request as a
// live_instructions message. One builder serves every file-backed skill.
function makeExtraFilePassthrough(name) {
  return ({ messages, index }) => {
    const { content } = instructions.getExtra(name)
    messages.splice(index, 1, {
      role: 'live_instructions',
      content,
    })
  }
}

/**
 * Fallback skill matcher for auto-registered MCP servers — called by
 * ToolCompiler.matchSkill when the leading trigger word isn't a static
 * entry in the triggers array but matches a tag in MCP_ALIAS_MAPS.
 *
 * @param {string} word - lowercased leading trigger word, e.g. '$playwright'
 * @returns {object|null}
 */
function matchMcpTrigger(word) {
  if (!MCP_ALIAS_MAPS[word]) return null
  return { trigger: word, template: '', passthrough: true, call: makePassthroughMcpCall(word) }
}

/**
 * Sync compiler.tools with the current set of MCP alias maps. Called on every
 * request so that newly added tools in req.body.tools[] are reflected in the
 * cached compiler without requiring a server restart. Once a tag is injected
 * for a session it stays for the lifetime of that session — never removed.
 *
 * @param {object} session
 * @param {object} compilerTools - compiler.tools (mutated in-place)
 * @param {Array}  [reqTools]    - req.body.tools[] from the current request
 * @param {string} [ideName]     - compiler IDE, selects SDK vs classic tool names
 */
function restoreMcpInjections(session, compilerTools, reqTools = {}, nameMap = {}) {
  const autoMaps = reqTools ? buildAutoAliasMaps(reqTools) : {}
  const wanted = new Set([...Object.keys(MCP_ALIAS_MAPS), ...Object.keys(autoMaps)])

  for (const tag of wanted) {
    const aliasMap = MCP_ALIAS_MAPS[tag] || autoMaps[tag]
    if (!aliasMap) continue

    const probeKey = MCP_ALIAS_PROBE_KEY[tag] || Object.keys(aliasMap)[0]
    if (probeKey && compilerTools[probeKey]) continue

    console.info('[SKILL]', tag, 'injected')
    injectMcpAliases(aliasMap, compilerTools, nameMap)
  }
}

// Per-file overrides for the auto-scanner. Any extra/*.md not listed here
// auto-registers as $<basename>. Hand-written triggers below always win —
// this map only controls the *name*/aliases an auto-generated entry gets.
const EXTRA_OVERRIDES = {
  agent: { trigger: '$agent', aliases: ['$x', '$save'] },
  instructions: { trigger: '$tools', aliases: ['$t', '$i'] },
  reminder: { trigger: '$reminder', aliases: ['$r'] },
  summary: { trigger: '$summary', aliases: ['$s'] },
}

// Hand-written triggers — these take precedence over auto-generated ones with
// the same trigger name ($test below shadows the auto-scanned test.md entry so
// its scratch-file seeding still runs).
const staticTriggers = [
  {
    trigger: '$req',
    template: 'See server temp/captures folder',
    call: ({ req }) => captureRequest(req),
  },
  {
    trigger: '$browser',
    aliases: ['$b'],
    template: '',
    passthrough: true, // does not end the stream — splices an INTERNAL message into the array, request continues to the provider
    call: makePassthroughMcpCall('$browser'),
  },
  {
    trigger: '$mcp',
    call: ({ req, parser }) => showAvailableMcpTags(req.body.tools, parser),
  },
  {
    trigger: '$mcp-dump',
    get template() {
      return '```json\n' + JSON.stringify(MCP_ALIAS_MAPS, null, 2) + '\n```'
    },
  },
  {
    trigger: '$test',
    get template() {
      const tempDir = path.join(TEST_ROOT, 'temp')
      fs.writeFileSync(path.join(tempDir, 'temp.txt'), 'Hello')
      fs.writeFileSync(path.join(tempDir, 'tempR.txt'), 'Hello Code')

      const { content } = instructions.getExtra('test')
      return content.split('#{cwd}#').join(TEST_ROOT)
    },
  },
  {
    trigger: '$C',
    template: 'TESTING ⟦cmd¦run=echo test⟧',
  },
]

// Auto-register one passthrough trigger per engine/extra/*.md file, unless a
// static trigger already claims that name.
function buildExtraTriggers() {
  const claimed = new Set()
  for (const t of staticTriggers) {
    claimed.add(t.trigger.toLowerCase())
    for (const a of t.aliases || []) claimed.add(a.toLowerCase())
  }

  const out = []
  for (const name of instructions.list()) {
    const override = EXTRA_OVERRIDES[name]
    const trigger = override?.trigger || `$${name}`
    if (claimed.has(trigger.toLowerCase())) continue
    out.push({
      trigger,
      aliases: override?.aliases,
      template: '',
      passthrough: true,
      call: makeExtraFilePassthrough(name),
    })
  }
  return out
}

const triggers = [...staticTriggers, ...buildExtraTriggers()]

function showAvailableMcpTags(reqTools, parser) {
  const autoMaps = buildAutoAliasMaps(reqTools || [])
  const tags = Object.keys(autoMaps)
  if (parser?.compiler?.ideName === 'vscode' && !tags.includes('$browser')) tags.push('$browser')
  if (tags.length) parser.emitText(`\nAvailable MCP tags: ${tags.join(', ')}\n\n`)
  else parser.emitText('No MCP tags registered yet!\n\n')
}

function handleSkill(skill, req, parser) {
  const provider = parser.compiler.provider

  if (skill.call) {
    const file = skill.call({ req, parser })
    if (file) console.debug(`[${provider}] Captured to ${file}`)
  }
  parser.emitAndEnd(skill.template || '')
}

module.exports = {
  triggers,
  handleSkill,
  showAvailableMcpTags,
  restoreMcpInjections,
  registerAutoMcpServers,
  matchMcpTrigger,
}
