/**
 * Helper to create OpenAI-compatible error response.
 */
function toOpenAIError(status, message, type, code) {
  return {
    error: {
      message,
      type: type || 'api_error',
      code: code || status,
    },
  }
}

module.exports = { toOpenAIError }
