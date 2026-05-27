/**
 * Application constants and configuration.
 */

const CONFIG = {
  PORT: process.env.PORT || 8000,
}

const MODELS = {
  deepseek: {
    id: 'deepseek',
    object: 'model',
    created: 1_700_000_000,
    owned_by: 'deepseek',
    context_length: 131_072,
    max_output_length: 8192,
    permission: [],
    root: 'deepseek',
    capabilities: ['chat', 'completion', 'streaming'],
  },
  chatgpt: {
    id: 'chatgpt',
    object: 'model',
    created: 1_700_000_000,
    owned_by: 'openai',
    context_length: 128_000,
    max_output_length: 16384,
    permission: [],
    root: 'chatgpt',
    capabilities: ['chat', 'completion', 'streaming'],
  },
  claude: {
    id: 'claude',
    object: 'model',
    created: 1_700_000_000,
    owned_by: 'anthropic',
    context_length: 200_000,
    max_output_length: 32768,
    permission: [],
    root: 'claude',
    capabilities: ['chat', 'completion', 'streaming'],
  },
}

const MODEL_ALIASES = {
  deepseek: 'deepseek',
  chatgpt: 'chatgpt',
  claude: 'claude',
}

module.exports = {
  CONFIG,
  MODELS,
  MODEL_ALIASES,
}
