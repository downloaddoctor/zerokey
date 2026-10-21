'use strict'

const { buildInceptionRouter } = require('./router')
const { models, reasoning, promptLimit, setupSteps } = require('./config')

module.exports = {
  name: 'inception',
  displayName: 'Inception (Mercury)',
  models,
  reasoning,
  promptLimit,
  setupSteps,
  defaultVision: false,
  reinjectEvery: 50,
  requiresCapture: false,
  createAPI: () => ({
    initializeFromJSON: async () => {},
    deleteSession: async () => {},
  }),
  validateCredentials: async (parsedFetch, username) => {
    void parsedFetch
    return { success: true, user: username || 'inception-user' }
  },
  validateFetch: () => [],
  buildRouter: buildInceptionRouter,
}
