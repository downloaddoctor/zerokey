/**
 * Qwen provider configuration.
 * Moved from config/constants.js
 */

const models = {
  title: 'Qwen',
  owned_by: 'alibaba',
  models: {
    'qwen3.7-plus': {
      id: 'qwen3.7-plus',
      name: 'Qwen3.7-Plus',
      vision: true,
      recommendedForTools: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 65_536,
      reasoning: ['Auto', 'Think', 'Fast'],
      defaultReasoning: 'Auto',
    },
    'qwen3.8-max': {
      id: 'qwen3.8-max',
      name: 'Qwen3.8-Max',
      vision: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 131_072,
      reasoning: ['Auto', 'Think', 'Fast'],
      defaultReasoning: 'Auto',
    },
    'qwen3.7-max': {
      id: 'qwen3.7-max',
      name: 'Qwen3.7-Max',
      vision: false,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 81_920,
      reasoning: ['Think', 'Fast'],
      defaultReasoning: 'Think',
    },
    'qwen3.6-plus': {
      id: 'qwen3.6-plus',
      name: 'Qwen3.6-Plus',
      vision: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 65_536,
      reasoning: ['Auto', 'Think', 'Fast'],
      defaultReasoning: 'Auto',
    },
    'qwen3.5-plus': {
      id: 'qwen3.5-plus',
      name: 'Qwen3.5-Plus',
      vision: true,
      created: 1_772_736_000,
      context_length: 1_000_000,
      max_output_length: 65_536,
      reasoning: ['Auto', 'Think', 'Fast'],
      defaultReasoning: 'Auto',
    },
    'qwen3.5-omni-plus': {
      id: 'qwen3.5-omni-plus',
      name: 'Qwen3.5-Omni-Plus',
      vision: true,
      created: 1_772_736_000,
      context_length: 262_144,
      max_output_length: 65_536,
      reasoning: [],
    },
  },
}

const reasoning = {
  labels: ['Auto', 'Think', 'Fast'],
  map: {
    Auto: {
      thinking_enabled: true,
      auto_thinking: true,
      thinking_mode: 'Auto',
      thinking_format: 'summary',
      auto_search: true,
    },
    Think: {
      thinking_enabled: true,
      auto_thinking: false,
      thinking_mode: 'Thinking',
      thinking_format: 'summary',
      auto_search: true,
    },
    Fast: {
      thinking_enabled: false,
      auto_thinking: false,
      thinking_mode: 'Fast',
      auto_search: true,
    },
  },
}

const promptLimit = 128_000

const setupSteps = {
  url: 'https://chat.qwen.ai',
  requestFilter: '/api/v2/chat/completions',
  instructions:
    'Open DevTools → Network tab. Visit chat.qwen.ai and start a conversation. ' +
    'Find a request to /api/v2/chat/completions. ' +
    'Right-click → Copy → Copy as fetch (Node.js).',
}

module.exports = { models, reasoning, promptLimit, setupSteps }
