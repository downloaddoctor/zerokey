/**
 * Claude provider configuration.
 * Moved from config/constants.js
 */

const models = {
  title: 'Claude',
  owned_by: 'anthropic',
  models: {
    'claude-sonnet-5-5': {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      vision: true,
      recommendedForTools: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 128_000,
      defaultReasoning: 'Medium',
    },
    'claude-sonnet-4-6': {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      vision: true,
      recommendedForTools: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 128_000,
      defaultReasoning: 'Low',
    },
    'claude-sonnet-5': {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      vision: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 128_000,
      defaultReasoning: 'Medium',
    },
    'claude-haiku-4-5-20251001': {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      vision: true,
      created: 1_772_736_000,
      context_length: 200_000,
      max_output_length: 64_000,
      reasoning: ['No Think', 'Think'],
      defaultReasoning: 'No Think',
    },
  },
}

const reasoning = {
  labels: ['Low', 'Low Think', 'Medium', 'Medium Think', 'High', 'High Think', 'Max', 'Max Think'],
  map: {
    Off: { think: false },
    Low: { think: false, tier: 'low' },
    'Low Think': { think: true, tier: 'low' },
    Medium: { think: false, tier: 'medium' },
    'Medium Think': { think: true, tier: 'medium' },
    High: { think: false, tier: 'high' },
    'High Think': { think: true, tier: 'high' },
    Max: { think: false, tier: 'max' },
    'Max Think': { think: true, tier: 'max' },
    // Haiku: extended thinking only, no tier budget
    Think: { think: true, extended: true },
    'No Think': { think: false, extended: false },
  },
}

const promptLimit = 64_000

const setupSteps = {
  url: 'https://claude.ai',
  requestFilter: '/api/organizations',
  instructions:
    'Open DevTools → Network tab. Visit claude.ai and start a conversation. ' +
    'Find a request to /api/organizations/.../chat_conversations/.../completion. ' +
    'Right-click → Copy → Copy as fetch (Node.js).',
}

module.exports = { models, reasoning, promptLimit, setupSteps }
