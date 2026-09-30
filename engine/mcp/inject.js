/**
 * Extract declared param names from a block syntax line, e.g.
 * browser_click target={str} element={str} doubleClick={bool} -> ['target', 'element', 'doubleClick']
 *
 * @param {string} syntax
 * @returns {string[]}
 */
function extractValidKeys(syntax) {
  const matches = syntax.match(/(\w+)=\{/g) || []
  return matches.map((m) => m.slice(0, -2))
}

/**
 * Register MCP alias-map tools into the compiler's tool table and build
 * the inline grammar block used for prompt injection (e.g. via $browser).
 *
 * Alias-map format: { toolName: [realName, syntaxLine] }
 *
 * Entry format: toolName: [realName, syntaxLine, sdkName?]. When ideName is
 * 'vscode-sdk' and sdkName is present, sdkName is used as the emitted tool.
 *
 * @param {object} aliasMap - e.g. BROWSER_MCP from ./browser.js
 * @param {object} compilerTools - compiler.tools (mutated in-place)
 * @param {string} [ideName] - compiler IDE ('vscode' | 'vscode-sdk' | ...)
 * @returns {string} newline-joined grammar block
 */
function injectMcpAliases(aliasMap, compilerTools, ideName) {
  const grammarLines = []

  for (const [toolName, [realName, syntax, sdkName]] of Object.entries(aliasMap)) {
    const emitted = ideName === 'vscode-sdk' && sdkName ? sdkName : realName
    if (!compilerTools[toolName]) {
      compilerTools[toolName] = {
        _passthrough: true,
        _validKeys: new Set(extractValidKeys(syntax)),
        tool: emitted,
        params: {},
        keys: {},
        transformer: () => { },
        transform: () => { },
        default: {},
        repeatable: null,
        array: null,
        split: false,
      }
    }
    grammarLines.push(syntax)
  }

  return grammarLines.join('\n')
}

module.exports = { injectMcpAliases, extractValidKeys }
