'use strict'

/**
 * The internal MHI tool loop.
 *
 * One provider call, one assistant evaluation, one executor batch, repeat.
 * Runs until the model returns prose only, the round cap is hit, or the
 * caller aborts. The client sees one SSE stream: every intermediate turn is
 * invisible.
 *
 * This module is provider-agnostic. Each router calls `runToolLoop` with a
 * closure that performs one upstream turn and streams the assistant text
 * through the pipeline as it arrives.
 */

const log = require('../../utils/log')
const toolBridge = require('../../engine/tool-bridge')
const bpi = require('../mhi')

const FILE_TOOLS = new Set(['read', 'ls', 'glob', 'grep', 'write', 'replace', 'view_image'])

/**
 * The grammar the model is offered. Unions:
 *   - client tools (payload.tools[]) when present, so a client's own
 *     registry wins where names collide
 *   - the internal tools enabled for this process, so a client that did not
 *     offer `view_image` can still call it
 */
function collectGrammarTools(payload, config) {
  const seen = new Map()
  if (Array.isArray(payload && payload.tools)) {
    for (const tool of payload.tools) {
      const name =
        tool && tool.function && typeof tool.function.name === 'string'
          ? tool.function.name
          : tool && typeof tool.name === 'string'
            ? tool.name
            : null
      if (name && !seen.has(name)) seen.set(name, tool)
    }
  }

  if (config.MHI_FILE_TOOLS) {
    for (const name of ['read', 'ls', 'glob', 'grep', 'write', 'replace']) {
      if (!seen.has(name)) {
        seen.set(name, internalToolDescription(name, config))
      }
    }
  }
  if (config.MHI_VIEW_IMAGE && !seen.has('view_image')) {
    seen.set('view_image', internalToolDescription('view_image', config))
  }
  if (config.MHI_CMD_TOOLS && !seen.has('cmd')) {
    seen.set('cmd', internalToolDescription('cmd', config))
  }
  return [...seen.values()]
}

function internalToolDescription(name, _config) {
  const schemas = {
    read: {
      description: 'Read a UTF-8 file inside the workspace, optionally a line range.',
      properties: { path: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } },
      required: ['path'],
    },
    ls: {
      description: 'List one directory inside the workspace.',
      properties: { path: { type: 'string' } },
      required: [],
    },
    glob: {
      description: 'Match file paths by glob pattern inside the workspace.',
      properties: {
        pattern: { type: 'string' },
        dir: { type: 'string' },
        max: { type: 'integer' },
      },
      required: ['pattern'],
    },
    grep: {
      description: 'Search file contents inside the workspace.',
      properties: {
        query: { type: 'string' },
        glob: { type: 'string' },
        max: { type: 'integer' },
      },
      required: ['query'],
    },
    write: {
      description: 'Create a new file inside the workspace. Refuses to overwrite.',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    replace: {
      description: 'Replace exactly one occurrence of `old` in a file.',
      properties: {
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
      },
      required: ['path', 'old', 'new'],
    },
    view_image: {
      description: 'Read an image file inside the workspace and attach it to the next turn.',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    cmd: {
      description:
        'Run an allowlisted program with an argument array. Capability flags gate write/network.',
      properties: {
        program: { type: 'string' },
        args: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'integer' },
      },
      required: ['program'],
    },
  }
  const shape = schemas[name] || { description: name, properties: {}, required: [] }
  return {
    type: 'function',
    function: {
      name,
      description: shape.description,
      parameters: {
        type: 'object',
        properties: shape.properties,
        required: shape.required,
      },
    },
  }
}

function internalWorkspaceContext(config) {
  const root = config.WORKSPACE_ROOTS[0]
  if (!root) return null
  return { rootPath: root, cwd: root }
}

/**
 * Run the loop.
 *
 * @param {object} options
 * @param {object} options.payload                mutable request payload
 * @param {object} options.pipeline               StreamPipeline instance
 * @param {object} options.config                 CONFIG (per process)
 * @param {(payload, signal) => Promise<{ assistantText: string }>} options.turn
 *        Run one upstream turn. Must stream assistant text through the
 *        pipeline itself and return the accumulated text.
 * @returns {Promise<{ assistantText: string, rounds: number }>}
 */
async function runToolLoop(options) {
  const { config } = options
  const signal = options.signal
  const maxRounds = config.MHI_MAX_ROUNDS

  const grammarTools = collectGrammarTools(options.payload, config)
  if (grammarTools.length === 0) {
    const result = await options.turn(options.payload, signal)
    return { assistantText: result.assistantText, rounds: 1 }
  }

  let payload = toolBridge.preparePayload({
    ...options.payload,
    tools: grammarTools,
  })

  const workspace = internalWorkspaceContext(config)
  let rounds = 0

  for (;;) {
    rounds += 1
    if (rounds > maxRounds) {
      log.warn(
        'MHI tool loop hit the round cap (' + maxRounds + '); ending with the last assistant turn.',
      )
      return { assistantText: '', rounds }
    }
    if (signal && signal.aborted) {
      const error = new Error('MHI tool loop aborted.')
      error.name = 'AbortError'
      throw error
    }

    const turn = await options.turn(payload, signal)
    const assistantText = turn.assistantText || ''

    const decision = bpi.evaluateAssistant(assistantText)
    if (decision.kind === 'final') {
      return { assistantText, rounds }
    }
    if (decision.kind === 'continue') {
      payload = bpi.appendResult(payload, decision.prompt)
      continue
    }

    const results = await bpi.executeCalls(decision.calls, {
      context: workspace,
      signal,
      fileTools: config.MHI_FILE_TOOLS,
      cmdTools: config.MHI_CMD_TOOLS,
      viewImage: config.MHI_VIEW_IMAGE,
      cmdPrograms: config.MHI_CMD_PROGRAMS,
      cmdProjectPrograms: config.MHI_CMD_PROJECT_PROGRAMS,
      cmdAllowWrite: config.MHI_CMD_ALLOW_WRITE,
      cmdAllowNetwork: config.MHI_CMD_ALLOW_NETWORK,
      cmdTimeoutMs: config.MHI_CMD_TIMEOUT_MS,
    })

    const formatted = bpi.formatResults(results)
    payload = bpi.appendResult(payload, formatted.text)
    if (Array.isArray(formatted.attachments) && formatted.attachments.length > 0) {
      payload.attachments = formatted.attachments
    }
  }
}

module.exports = {
  FILE_TOOLS,
  collectGrammarTools,
  internalToolDescription,
  internalWorkspaceContext,
  runToolLoop,
}
