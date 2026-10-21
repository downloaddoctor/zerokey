'use strict'

/**
 * Inception (Mercury) provider configuration.
 * Only values seen in a real chat.inceptionlabs.ai capture are declared here.
 */

const models = {
  title: 'Inception',
  owned_by: 'inception',
  models: {
    mercury: {
      id: 'mercury',
      name: 'Mercury',
      vision: false,
      recommendedForTools: true,
      created: 1_792_569_000,
      context_length: 128_000,
      max_output_length: 16_384,
      reasoning: ['Instant', 'Low', 'Medium', 'High'],
      defaultReasoning: 'Medium',
    },
  },
}

const reasoning = {
  labels: ['Instant', 'Low', 'Medium', 'High'],
  map: {
    Instant: 'instant',
    Low: 'low',
    Medium: 'medium',
    High: 'high',
  },
}

const promptLimit = 64_000

const setupSteps = {
  url: 'https://chat.inceptionlabs.ai',
  requestFilter: null,
  instructions: 'No capture needed — the provider is authless and browser-only.',
}

module.exports = { models, reasoning, promptLimit, setupSteps }
