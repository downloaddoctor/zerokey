'use strict'

/**
 * Central limits shared by the internal MHI executors and loop guards.
 * Single source of truth — do not hardcode these anywhere else.
 */
const LIMITS = Object.freeze({
  // files.js
  MAX_FILE_BYTES: 1024 * 1024,
  MAX_OUTPUT_BYTES: 64 * 1024,
  MAX_GREP_FILES: 2000,
  MAX_GREP_TOTAL_BYTES: 16 * 1024 * 1024,
  GREP_TIMEOUT_MS: 10000,
  // view-image.js
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  // path-policy.js
  MAX_PATH_CHARS: 4096,
  // commands.js
  MAX_ARGUMENTS: 128,
  MAX_ARGUMENT_CHARS: 4096,
  MAX_ARGUMENT_TOTAL_CHARS: 32768,
  MAX_PROGRAM_CHARS: 128,
  MAX_TIMEOUT_MS: 300000,
  DEFAULT_TIMEOUT_MS: 30000,
  // parser.js
  MAX_BLOCKS: 20,
  MAX_BLOCK_CHARS: 1024 * 1024,
  MAX_TOTAL_CHARS: 2 * 1024 * 1024,
  // loop-guard.js
  MAX_BATCH: 20,
  MAX_HISTORY: 24,
  // tool-bridge.js
  MAX_TOOLS: 128,
  MAX_CALLS: 20,
  MAX_DESCRIPTION_CHARS: 240,
})

module.exports = { LIMITS }
