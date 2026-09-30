// Hand-written alias map for the IDE's built-in browser tools.
// Entry format: toolName: [realName, syntaxLine, sdkName?]
//   realName — classic VS Code tool name
//   sdkName  — VS Code Copilot SDK native name (used when ideName='copilot')
const BROWSER_MCP = {
  click_element: [
    'click_element',
    `⟦click_element¦pageId={str}¦element={str}(¦ref={str})?(¦selector={str})?(¦dblClick={bool})?(¦button={left|right|middle})?⟧ — click element (ref or selector required alongside element)`,
    'clickElement',
  ],
  drag_element: [
    'drag_element',
    `⟦drag_element¦pageId={str}¦fromElement={str}¦toElement={str}(¦fromRef={str})?(¦fromSelector={str})?(¦toRef={str})?(¦toSelector={str})?⟧ — drag one element onto another`,
    'dragElement',
  ],
  hover_element: [
    'hover_element',
    `⟦hover_element¦pageId={str}¦element={str}(¦ref={str})?(¦selector={str})?⟧ — hover over element`,
    'hoverElement',
  ],
  handle_dialog: [
    'handle_dialog',
    `⟦handle_dialog¦pageId={str}(¦acceptModal={bool})?(¦promptText={str})?(¦selectFiles={json})?⟧ — respond to modal/file-chooser dialog (selectFiles: JSON array of paths)`,
    'handleDialog',
  ],
  navigate_page: [
    'navigate_page',
    `⟦navigate_page¦pageId={str}(¦type={url|back|forward|reload})?(¦url={str})?⟧ — navigate by URL/history/reload`,
    'navigatePage',
  ],
  open_browser_page: [
    'open_browser_page',
    `⟦open_browser_page¦url={str}(¦forceNew={bool})?⟧ — open a new browser page`,
    'openBrowserPage',
  ],
  read_page: ['read_page', `⟦read_page¦pageId={str}⟧ — accessibility snapshot of page`, 'readPage'],
  run_playwright_code: [
    'run_playwright_code',
    `⟦run_playwright_code¦pageId={str}(¦code={str})?(¦deferredResultId={str})?(¦timeoutMs={int})?⟧ — run raw Playwright code (code or deferredResultId required)`,
    'runPlaywrightCode',
  ],
  screenshot_page: [
    'screenshot_page',
    `⟦screenshot_page¦pageId={str}(¦ref={str})?(¦selector={str})?(¦element={str})?(¦scrollIntoViewIfNeeded={bool})?⟧ — screenshot of page or element`,
    'screenshotPage',
  ],
  type_in_page: [
    'type_in_page',
    `⟦type_in_page¦pageId={str}(¦text={str})?(¦key={str})?(¦submit={bool})?(¦ref={str})?(¦selector={str})?(¦element={str})?⟧ — type text or press keys (text or key required)`,
    'typeInPage',
  ],
}

module.exports = BROWSER_MCP
