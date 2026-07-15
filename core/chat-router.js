const BUILDERS = {
  chatgpt: require('../routes/chatgpt').buildChatGPTRouter,
  claude: require('../routes/claude').buildClaudeRouter,
  deepseek: require('../routes/deepseek').buildChatRouter,
}

async function buildRouter(selected) {
  const build = BUILDERS[selected.provider]
  if (!build) throw new Error(`Unknown provider: ${selected.provider}`)
  const router = await build(selected.parsedFetch, selected.session, selected.userData)
  // console.log(`[ChatRouter] Active: ${selected.user} - ${selected.provider} - ${selected.sessionName}`)
  return router
}

module.exports = buildRouter
