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
      reasoning: [
        'Instant',
        'Low',
        'Medium',
        'High',
        'Instant Search',
        'Low Search',
        'Medium Search',
        'High Search',
      ],
      defaultReasoning: 'Medium',
    },
  },
}

const reasoning = {
  labels: [
    'Instant',
    'Low',
    'Medium',
    'High',
    'Instant Search',
    'Low Search',
    'Medium Search',
    'High Search',
  ],
  map: {
    Instant: { effort: 'instant', search: false },
    Low: { effort: 'low', search: false },
    Medium: { effort: 'medium', search: false },
    High: { effort: 'high', search: false },
    'Instant Search': { effort: 'instant', search: true },
    'Low Search': { effort: 'low', search: true },
    'Medium Search': { effort: 'medium', search: true },
    'High Search': { effort: 'high', search: true },
  },
}

const promptLimit = 64_000

// Every 47th prompt sent upstream asks Mercury for a session summary, then the
// router opens a new chat seeded with the base prompt plus that summary.
const summaryAt = 47

const setupSteps = {
  url: 'https://chat.inceptionlabs.ai',
  requestFilter: null,
  instructions: 'No capture needed — the provider is authless and browser-only.',
}

module.exports = {
  models,
  reasoning,
  promptLimit,
  summaryAt,
  setupSteps,
}
