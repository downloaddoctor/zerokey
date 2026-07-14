/**
 * Application constants and configuration.
 */

const CONFIG = {
  PORT: process.env.PORT || 8000,
}

const MODELS = {
  'DeepSeek V4': {
    id: 'DeepSeek V4',
    object: 'model',
    created: 1_784_736_000,
    owned_by: 'deepseek',
    context_length: 1_000_000,
    max_output_length: 384_000,
  },
  'GPT-4o': {
    id: 'GPT-4o',
    object: 'model',
    created: 1_712_822_400,
    owned_by: 'openai',
    context_length: 128_000,
    max_output_length: 16_384,
  },
  'Claude Sonnet 4.6': {
    id: 'Claude Sonnet 4.6',
    object: 'model',
    created: 1_772_736_000,
    owned_by: 'anthropic',
    context_length: 1_000_000,
    max_output_length: 128_000,
  },
  'Claude Sonnet 5': {
    id: 'Claude Sonnet 5',
    object: 'model',
    created: 1_772_736_000,
    owned_by: 'anthropic',
    context_length: 1_000_000,
    max_output_length: 128_000,
  },
  'Claude Haiku 4.5': {
    id: 'Claude Haiku 4.5',
    object: 'model',
    created: 1_772_736_000,
    owned_by: 'anthropic',
    context_length: 200_000,
    max_output_length: 64_000,
  },
}

module.exports = { CONFIG, MODELS }
