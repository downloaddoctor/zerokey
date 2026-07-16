/**
 * Application constants and configuration.
 */

const CONFIG = {
  PORT: process.env.PORT || 8000,
}

const MODEL_HASH = {
  claude: {
    title: 'Claude',
    owned_by: 'anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        vision: true,
        created: 1_772_736_000,
        context_length: 1_000_000,
        max_output_length: 128_000,
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        vision: true,
        created: 1_772_736_000,
        context_length: 1_000_000,
        max_output_length: 128_000,
      },
      'claude-haiku-4-5-20251001': {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        vision: true,
        created: 1_772_736_000,
        context_length: 200_000,
        max_output_length: 64_000,
      },
    },
  },
  chatgpt: {
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
  },
  deepseek: {
    title: 'DeepSeek',
    owned_by: 'deepseek',
    models: {
      expert: {
        id: 'expert',
        name: 'DeepSeek V4 - Expert',
        vision: false,
        created: 1_784_736_000,
        context_length: 1_000_000,
        max_output_length: 384_000,
      },
      default: {
        id: 'default',
        name: 'DeepSeek V4 - Instant',
        vision: true,
        created: 1_784_736_000,
        context_length: 1_000_000,
        max_output_length: 384_000,
      },
      vision: {
        id: 'vision',
        name: 'DeepSeek V4 - Vision',
        vision: true,
        created: 1_784_736_000,
        context_length: 1_000_000,
        max_output_length: 384_000,
      },
    },
  },
}

const MODELS = {}
for (const provider of Object.values(MODEL_HASH)) {
  for (const meta of Object.values(provider.models)) {
    MODELS[meta.id] = {
      id: meta.id,
      name: meta.name,
      object: 'model',
      created: meta.created,
      owned_by: provider.owned_by,
      context_length: meta.context_length,
      max_output_length: meta.max_output_length,
    }
  }
}

module.exports = { CONFIG, MODELS, MODEL_HASH }
