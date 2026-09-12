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
    // vscode-only: $browser/$playwright rely on VS Code's own MCP tool
    // surface — silently no-op on other IDEs rather than injecting grammar
    // they have no way to execute.
    if (parser?.compiler?.ideName !== 'vscode') return

    const aliasMap = MCP_ALIAS_MAPS[tag]
    const grammar = injectMcpAliases(aliasMap, compilerTools)
    // const message = messages[index]
    // message.content = message.content.replace(tag, '').trim()
    messages.splice(index, 1, {
      role: 'internal',
      content: `<${SYNTAX.xNAME}_list title="${tag.slice(1)} tools">\n${grammar}\n</${SYNTAX.xNAME}_list>`,
    })
    markMcpInjected(parser?.session, tag)
  }
}

function makeCoreToolsPassthrough() {
  return ({ messages, index }) => {
    messages.splice(index, 1, {
      role: 'internal',
      content: instructions.getBase().content,
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
 */
function restoreMcpInjections(session, compilerTools, reqTools = {}) {
  const autoMaps = reqTools ? buildAutoAliasMaps(reqTools) : {}
  const wanted = new Set([...Object.keys(MCP_ALIAS_MAPS), ...Object.keys(autoMaps)])

  for (const tag of wanted) {
    const aliasMap = MCP_ALIAS_MAPS[tag] || autoMaps[tag]
    if (!aliasMap) continue

    const probeKey = MCP_ALIAS_PROBE_KEY[tag] || Object.keys(aliasMap)[0]
    if (probeKey && compilerTools[probeKey]) continue

    console.info('[SKILL]', tag, 'injected')
    injectMcpAliases(aliasMap, compilerTools)
  }
}

const triggers = [
  {
    trigger: '$cwd',
    template: '⟦cmd¦run=pwd⟧',
  },
  {
    trigger: '$save',
    template:
      '⟦cmd¦run=git status --short¦run=git --no-pager diff --staged¦run=git --no-pager diff⟧',
  },
  {
    trigger: '$req',
    template: 'See server temp/captures folder',
    call: ({ req }) => captureRequest(req),
  },
  {
    trigger: '$browser',
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
    trigger: '$tools',
    template: '',
    passthrough: true,
    call: makeCoreToolsPassthrough(),
  },
  {
    trigger: '$test',
    get template() {
      return TEST_TEMPLATE.split('#{cwd}#').join(TEST_ROOT)
    },
  },
]

const TEST_TEMPLATE = `Testing all basic tools...

⟦todos_add¦id=1¦title=Execute todos_add command¦desc=Add Task One and Task Two
¦id=2¦title=Execute todos_set command¦desc=Set Task 1 status to done
¦id=3¦title=Execute write command¦desc=Write _test_tool.txt
¦id=4¦title=Execute read command (1st)¦desc=Read _test_tool.txt after write
¦id=5¦title=Execute replace command¦desc=Replace content in _test_tool.txt
¦id=6¦title=Execute read command (2nd)¦desc=Read _test_tool.txt after replace
¦id=7¦title=Execute ls command (1st)¦desc=List current directory
¦id=8¦title=Execute glob command¦desc=Search **/*.js max 10
¦id=9¦title=Execute grep command¦desc=Search Router in *.js max 5
¦id=10¦title=Execute cmd echo test¦desc=Run 'echo test'
¦id=11¦title=Execute cmd delete file¦desc=Delete _test_tool.txt
¦id=12¦title=Execute mkdir command¦desc=Create _test_dir
¦id=13¦title=Execute ls command (2nd)¦desc=List directory after mkdir
¦id=14¦title=Execute cmd_bg command¦desc=Run ping -n 5 127.0.0.1 in background
¦id=15¦title=Execute fetch command¦desc=Fetch JSONPlaceholder todo/1
¦id=16¦title=Execute view_image command¦desc=View docs/logos/terax.png
¦id=17¦title=Execute final echo command¦desc=Display "above all where testing..."⟧


⟦todos_set¦id=1¦status=done⟧
Escaping test - \`⟦todos_set¦id=2¦status=done⟧\`
⟦todos_set¦id=2¦status=done⟧

⟦todos_set¦id=3¦status=active⟧
⟦write¦path=#{cwd}#\\temp\\_test_tool.txt¦content=Hello from write tool!⟧
⟦todos_set¦id=3¦status=done⟧

⟦todos_set¦id=4¦status=active⟧
⟦read¦path=#{cwd}#\\start.bat⟧
⟦todos_set¦id=4¦status=done⟧

⟦todos_set¦id=5¦status=active⟧
⟦replace¦path=#{cwd}#\\start.bat¦old=pause¦new=pause\n⟧
⟦todos_set¦id=5¦status=done⟧

⟦todos_set¦id=6¦status=active⟧
⟦read¦path=#{cwd}#\\.prettierrc⟧
⟦todos_set¦id=6¦status=done⟧

⟦todos_set¦id=7¦status=active⟧
⟦ls¦path=#{cwd}#⟧
⟦todos_set¦id=7¦status=done⟧

⟦todos_set¦id=8¦status=active⟧
⟦glob¦pattern=#{cwd}#/**/*.js¦max=5⟧
⟦todos_set¦id=8¦status=done⟧

⟦todos_set¦id=9¦status=active⟧
⟦grep¦query=Router¦glob=#{cwd}#/**/*.js¦max=5⟧
⟦todos_set¦id=9¦status=done⟧

⟦todos_set¦id=10¦status=active⟧
⟦cmd¦run=echo test⟧
⟦todos_set¦id=10¦status=done⟧

⟦todos_set¦id=11¦status=active⟧
⟦cmd¦run=del #{cwd}#\\temp\\_test_tool.txt⟧
⟦todos_set¦id=11¦status=done⟧

⟦todos_set¦id=12¦status=active⟧
⟦mkdir¦path=#{cwd}#\\temp\\_test_dir⟧
⟦todos_set¦id=12¦status=done⟧

⟦todos_set¦id=13¦status=active⟧
⟦ls¦path=#{cwd}#⟧
⟦todos_set¦id=13¦status=done⟧

⟦todos_set¦id=14¦status=active⟧
⟦cmd_bg¦run=ping -n 5 127.0.0.1⟧
⟦todos_set¦id=14¦status=done⟧

⟦todos_set¦id=15¦status=active⟧
⟦fetch¦url=https://jsonplaceholder.typicode.com/todos/1⟧
⟦todos_set¦id=15¦status=done⟧

⟦todos_set¦id=16¦status=active⟧
⟦view_image¦path=#{cwd}#\\docs\\logos\\terax.png⟧
⟦todos_set¦id=16¦status=done⟧

⟦todos_set¦id=17¦status=active⟧
⟦ask¦question=All tools called, are they working?¦option=Yes¦option=No¦option=Something else⟧
⟦todos_set¦id=17¦status=done⟧

⟦cmd¦run=echo "ABOVE ALL WHERE TESTING CALLS OF:
Execute todos_add command => Add Task One and Task Two
Execute todos_set command => Set Task 1 status to done
Execute write command => Write _test_tool.txt
Execute read command (1st) => Read _test_tool.txt after write
Execute replace command => Replace content in _test_tool.txt
Execute read command (2nd) => Read _test_tool.txt after replace
Execute ls command (1st) => List current directory
Execute glob command => Search **/*.js max 10
Execute grep command => Search Router in *.js max 5
Execute cmd echo test => Run 'echo test'
Execute cmd delete file => Delete _test_tool.txt
Execute mkdir command => Create _test_dir
Execute ls command (2nd) => List directory after mkdir
Execute cmd_bg command => Run ping -n 5 127.0.0.1 in background
Execute fetch command => Fetch JSONPlaceholder todo/1
Execute view_image command => View docs/logos/terax.png
Execute final echo command => Display above all where testing...

SO DO ANALSIS OF IT AND GIVE USER SUMMARY WHICH WORKS WHICH NOT WORKS

"⟧
`

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
