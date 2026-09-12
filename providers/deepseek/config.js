/**
 * DeepSeek provider configuration.
 * Single source of truth — moved from config/constants.js
 */

const models = {
  title: 'DeepSeek',
  owned_by: 'deepseek',
  models: {
    default: {
      id: 'default',
      name: 'DeepSeek V4.1',
      vision: true,
      created: 1_784_736_000,
      context_length: 1_000_000,
      max_output_length: 384_000,
    },
  },
}

const reasoning = {
  labels: ['Off', 'Search', 'DeepThink', 'DeepThink Search'],
  map: {
    Off: { think: false, search: false },
    Search: { think: false, search: true },
    DeepThink: { think: true, search: false },
    'DeepThink Search': { think: true, search: true },
  },
}

const promptLimit = 128_000

const setupSteps = {
  url: 'https://chat.deepseek.com',
  requestFilter: '/api/v0/chat/completion',
  instructions:
    'Open DevTools → Network tab. Visit chat.deepseek.com and start a conversation. ' +
    'Find a request to /api/v0/chat/completion. Right-click → Copy → Copy as fetch (Node.js).',
}

module.exports = { models, reasoning, promptLimit, setupSteps }
