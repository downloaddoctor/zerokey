/**
 * ChatGPT provider configuration.
 * Moved from config/constants.js
 */

const models = {
  title: 'Chatgpt',
  owned_by: 'openai',
  models: {
    auto: {
      id: 'auto',
      name: 'GPT-4o',
      vision: true,
      created: 1_712_822_400,
      context_length: 128_000,
      max_output_length: 16_384,
    },
  },
}

const reasoning = {
  labels: [],
  map: {},
}

const promptLimit = 50_000

const setupSteps = {
  url: 'https://chatgpt.com',
  requestFilter: '/backend-api/f/conversation',
  instructions:
    'Open DevTools → Network tab. Visit chatgpt.com and start a conversation. ' +
    'Find a request to /backend-api/f/conversation. ' +
    'Right-click → Copy → Copy as fetch (Node.js).',
}

module.exports = { models, reasoning, promptLimit, setupSteps }
