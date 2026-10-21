/**
 * Claude provider configuration.
 * Moved from config/constants.js
 */

const model = (id, name, defaultReasoning, extra = {}) => ({
  id,
  name,
  vision: true,
  created: 1_772_736_000,
  context_length: 1_000_000,
  max_output_length: 128_000,
  defaultReasoning,
  ...extra,
})

const models = {
  title: 'Claude',
  owned_by: 'anthropic',
  models: {
    'claude-fable-5-1': model('claude-fable-5-1', 'Claude Fable 5.1', 'Medium Think'),
    'claude-opus-5-5': model('claude-opus-5-5', 'Claude Opus 5.5', 'Medium Think'),
    'claude-sonnet-5-5': model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Medium Think', {
      recommendedForTools: true,
    }),
    'claude-haiku-5-5': model('claude-haiku-5-5', 'Claude Haiku 5.5', 'Medium Think'),
    'claude-fable-5': model('claude-fable-5', 'Claude Fable 5', 'High Think'),
    'claude-opus-5': model('claude-opus-5', 'Claude Opus 5', 'High Think'),
    'claude-opus-4-8': model('claude-opus-4-8', 'Claude Opus 4.8', 'High Think'),
    'claude-opus-4-7': model('claude-opus-4-7', 'Claude Opus 4.7', 'XHigh Think'),
    'claude-opus-4-6': model('claude-opus-4-6', 'Claude Opus 4.6', 'Medium Think'),
    'claude-sonnet-5': model('claude-sonnet-5', 'Claude Sonnet 5', 'Medium Think'),
    'claude-sonnet-4-6': model('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Low', {
      recommendedForTools: true,
    }),
    'claude-haiku-4-5-20251001': model(
      'claude-haiku-4-5-20251001',
      'Claude Haiku 4.5',
      'No Think',
      {
        context_length: 200_000,
        max_output_length: 64_000,
        reasoning: ['No Think', 'Think'],
      },
    ),
  },
}

const reasoning = {
  labels: [
    'Low',
    'Low Think',
    'Medium',
    'Medium Think',
    'High',
    'High Think',
    'XHigh',
    'XHigh Think',
    'Max',
    'Max Think',
  ],
  map: {
    Off: { think: false },
    Low: { think: false, tier: 'low' },
    'Low Think': { think: true, tier: 'low' },
    Medium: { think: false, tier: 'medium' },
    'Medium Think': { think: true, tier: 'medium' },
    High: { think: false, tier: 'high' },
    'High Think': { think: true, tier: 'high' },
    XHigh: { think: false, tier: 'xhigh' },
    'XHigh Think': { think: true, tier: 'xhigh' },
    Max: { think: false, tier: 'max' },
    'Max Think': { think: true, tier: 'max' },
    // Haiku 4.5: mode only (no effort tier)
    Think: { think: true, extended: true },
    'No Think': { think: false, extended: false },
  },
}

const promptLimit = 64_000

const setupSteps = {
  url: 'https://claude.ai',
  requestFilter: '/completion  or  /claudeai-rpc/.../StreamTimeline',
  instructions:
    'Open DevTools → Network tab. Visit claude.ai and start a conversation. ' +
    'Copy either the /completion request or the /claudeai-rpc/.../ConversationService/StreamTimeline request. ' +
    'Either one works. ' +
    'Right-click → Copy → Copy as fetch (Node.js). ' +
    'The copy MUST include the cookie header — a cookieless capture 403s at Cloudflare.',
}

module.exports = { models, reasoning, promptLimit, setupSteps }
