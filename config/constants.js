/**
 * Application constants and configuration.
 */

const CONFIG = {
  PORT: process.env.PORT || 7250,
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
  glm: {
    title: 'GLM',
    owned_by: 'zhipu',
    models: {
      'glm-5.3': {
        id: 'glm-5.3',
        name: 'GLM 5.3',
        vision: true,
        created: 1_780_000_000,
        context_length: 128_000,
        max_output_length: 32_000,
      },
      'glm-5.3-flash': {
        id: 'glm-5.3-flash',
        name: 'GLM 5.3 Flash',
        vision: true,
        created: 1_780_000_000,
        context_length: 128_000,
        max_output_length: 32_000,
      },
      'glm-5': {
        id: 'glm-5',
        name: 'GLM 5',
        vision: true,
        created: 1_770_000_000,
        context_length: 128_000,
        max_output_length: 32_000,
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM 4.7',
        vision: true,
        created: 1_760_000_000,
        context_length: 128_000,
        max_output_length: 32_000,
      },
    },
  },
}

const PROMPT_LIMITS = {
  claude: 64_000,
  chatgpt: 50_000,
  deepseek: 128_000,
  glm: 64_000,
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

module.exports = { CONFIG, MODELS, MODEL_HASH, PROMPT_LIMITS }
