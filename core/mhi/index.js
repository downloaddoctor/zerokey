'use strict'

/**
 * Internal MHI executor.
 *
 * Decides which tool a call belongs to and dispatches. Returns a plain result
 * object for every call, never throws on a normal execution failure (only on
 * caller abort). This is what makes the internal tool loop behave predictably
 * for the model: a failed call is data, not an exception.
 */

const parser = require('./parser')
const files = require('./files')
const commands = require('./commands')
const viewImage = require('./view-image')

const FILE_TOOLS = new Set(['read', 'ls', 'glob', 'grep', 'write', 'replace'])
const MAX_ROUNDS = 8

function normalizeEnablement(value) {
  if (value && typeof value === 'object') {
    return {
      fileTools: value.fileTools !== false,
      cmdTools: value.cmdTools === true,
      viewImage: value.viewImage !== false,
    }
  }
  return { fileTools: value !== false, cmdTools: false, viewImage: false }
}

async function executeCalls(calls, options) {
  const results = []
  for (const call of calls) {
    if (options.signal && options.signal.aborted) {
      const error = new Error('MHI execution aborted.')
      error.name = 'AbortError'
      error.code = 'mhi_aborted'
      throw error
    }

    if (call.tool === 'cmd') {
      if (!options.cmdTools) {
        results.push({
          tool: 'cmd',
          ok: false,
          code: 'mhi_cmd_disabled',
          output: 'ERROR [mhi_cmd_disabled] Command execution is not enabled.',
        })
        continue
      }
      results.push(await commands.execute(call, { ...options, enabled: true }))
      continue
    }

    if (call.tool === 'view_image') {
      if (!options.viewImage) {
        results.push({
          tool: 'view_image',
          ok: false,
          code: 'mhi_view_image_disabled',
          output: 'ERROR [mhi_view_image_disabled] view_image is not enabled.',
        })
        continue
      }
      results.push(await viewImage.execute(call, { ...options, enabled: true }))
      continue
    }

    if (!FILE_TOOLS.has(call.tool)) {
      results.push({
        tool: call.tool,
        ok: false,
        code: 'mhi_unknown_tool',
        output: 'ERROR [mhi_unknown_tool] ' + call.tool + ' is not an internal tool.',
      })
      continue
    }

    if (!options.fileTools) {
      results.push({
        tool: call.tool,
        ok: false,
        code: 'mhi_file_tools_disabled',
        output: 'ERROR [mhi_file_tools_disabled] File tools are not enabled.',
      })
      continue
    }

    results.push(await files.execute(call, options))
  }
  return results
}

/**
 * Turn a list of execution results into a single text block for the next
 * upstream turn. Attachments (from view_image) are collected separately so the
 * caller can pass them to the provider's uploadFile.
 */
function formatResults(results) {
  const lines = []
  const attachments = []
  for (const result of results) {
    lines.push('MHI(' + result.tool + '): ' + result.output)
    if (result.attachment) attachments.push(result.attachment)
  }
  return { text: lines.join('\n\n'), attachments }
}

/**
 * Evaluate a single assistant turn. Returns:
 *   { kind: 'final', text }
 *   { kind: 'calls', calls }
 *   { kind: 'continue', prompt, reason }   — repair round needed
 */
function evaluateAssistant(text) {
  let parsed
  try {
    parsed = parser.parseAssistantText(text)
  } catch (error) {
    if (error.code === 'mhi_unknown_tool') {
      // The model invented a tool name (e.g. "cat", "MHI(ls)"). A generic
      // "resend" repair just repeats the same bad block, so name the valid
      // tools instead and let it pick a real one.
      const valid = Object.keys(parser.DEFINITIONS).join(', ')
      return {
        kind: 'continue',
        prompt:
          'MHI(parser): ERROR [mhi_unknown_tool] ' +
          (error.message || 'Unknown tool.') +
          ' Valid tools: ' +
          valid +
          '. Use one of these or answer in plain prose with no blocks.',
        reason: 'mhi_unknown_tool',
      }
    }
    console.error('parser.parseAssistantText() failed:', error)
    return {
      kind: 'continue',
      prompt:
        'MHI(parser): ERROR [' +
        (error.code || 'mhi_parse_error') +
        '] ' +
        (error.message || 'Invalid tool call.') +
        ' Resend only complete blocks, no prose.',
      reason: error.code || 'mhi_parse_error',
    }
  }

  if (parsed.kind === 'text' && parsed.mixed) {
    return {
      kind: 'continue',
      prompt:
        'MHI(parser): ERROR [mhi_mixed_output] Blocks and prose must not be mixed. ' +
        'Resend only the complete blocks, no text before or after them.',
      reason: 'mhi_mixed_output',
    }
  }
  if (parsed.kind === 'text') return { kind: 'final', text: parsed.text }
  return { kind: 'calls', calls: parsed.calls }
}

/**
 * Append a MHI result block to the payload's messages as a user turn. The
 * pipeline feeds this back to the provider for the next upstream round.
 */
function appendResult(payload, resultText) {
  const messages = Array.isArray(payload.messages) ? payload.messages.map((m) => ({ ...m })) : []
  messages.push({ role: 'mhi', content: resultText })
  return { ...payload, messages, attachments: [] }
}

module.exports = {
  FILE_TOOLS,
  MAX_ROUNDS,
  appendResult,
  commands,
  evaluateAssistant,
  executeCalls,
  files,
  formatResults,
  normalizeEnablement,
  parser,
  viewImage,
}
