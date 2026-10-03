'use strict'

/**
 * Bounded file executors for the internal tool loop.
 *
 * read  - UTF-8 only, <=1 MiB, optional line range
 * grep  - walk from cwd, skip .git/node_modules, bounded files/bytes/time
 * ls    - single directory listing
 * glob  - pattern match inside one directory subtree
 * write - new files only, atomic via temp + link
 * replace - exact single match, atomic via temp + rename
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { MhiFileError, scope } = require('./path-policy')

const MAX_FILE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_GREP_FILES = 2000
const MAX_GREP_TOTAL_BYTES = 16 * 1024 * 1024
const GREP_TIMEOUT_MS = 10000

function abortError() {
  const error = new Error('MHI file operation aborted.')
  error.name = 'AbortError'
  error.code = 'mhi_aborted'
  return error
}

function assertActive(signal) {
  if (signal && signal.aborted) throw abortError()
}

function decodeUtf8(buffer) {
  if (buffer.includes(0))
    throw new MhiFileError('mhi_binary_file', 'Binary files are not processed.')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new MhiFileError('mhi_invalid_utf8', 'File is not valid UTF-8.')
  }
}

function boundedOutput(value) {
  const text = String(value)
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text
  const suffix = '\n[output capped at ' + MAX_OUTPUT_BYTES + ' bytes]'
  const available = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(suffix))
  let end = Math.min(text.length, available)
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > available) end -= 1
  return text.slice(0, end) + suffix
}

function readText(file) {
  if (file.stat.size > MAX_FILE_BYTES) {
    throw new MhiFileError('mhi_file_too_large', 'File exceeds ' + MAX_FILE_BYTES + ' bytes.')
  }
  const buffer = fs.readFileSync(file.path)
  if (buffer.length > MAX_FILE_BYTES) {
    throw new MhiFileError('mhi_file_too_large', 'File exceeds ' + MAX_FILE_BYTES + ' bytes.')
  }
  return decodeUtf8(buffer)
}

function atomicWrite(target, content, replaceExisting) {
  const directory = path.dirname(target)
  const temporary = path.join(
    directory,
    '.' + path.basename(target) + '.zerokey-' + process.pid + '-' + crypto.randomUUID() + '.tmp',
  )
  let descriptor = null
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    if (replaceExisting) {
      fs.renameSync(temporary, target)
    } else {
      try {
        fs.linkSync(temporary, target)
      } catch (error) {
        if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
          throw new MhiFileError('mhi_file_exists', 'write creates new files only.')
        }
        throw error
      }
      fs.unlinkSync(temporary)
    }
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {}
    }
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
}

function readOperation(call, fileScope, signal) {
  assertActive(signal)
  const file = fileScope.existingFile(call.params.path)
  const text = readText(file)
  const lines = text.split(/\r?\n/)
  const from = call.params.from || 1
  const to = call.params.to || lines.length
  const selected = lines
    .slice(from - 1, to)
    .map((line, index) => String(from + index) + ': ' + line)
    .join('\n')
  return {
    relativePath: file.relativePath,
    output:
      '<path>' +
      file.relativePath +
      '</path>\n<content>\n' +
      boundedOutput(selected) +
      '\n</content>',
  }
}

function lsOperation(call, fileScope, signal) {
  assertActive(signal)
  const dir = call.params.path
    ? fileScope.existingDirectory(call.params.path)
    : fileScope.existingDirectory(fileScope.rootPath)
  const entries = fs.readdirSync(dir.path, { withFileTypes: true })
  const lines = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort()
  return {
    relativePath: dir.relativePath,
    output: lines.length === 0 ? '(empty)' : lines.join('\n'),
  }
}

function toForwardSlashes(value) {
  const BS = String.fromCharCode(0x5c)
  return String(value).split(BS).join('/')
}

const REGEX_METACHARS = '|' + String.fromCharCode(0x5c) + '{}()[]^$+?.' + '*'

function escapeRegexChar(char) {
  if (REGEX_METACHARS.includes(char)) {
    return String.fromCharCode(0x5c) + char
  }
  return char
}

function globRegex(pattern) {
  const value = typeof pattern === 'string' && pattern !== '' ? toForwardSlashes(pattern) : '**'
  if (path.isAbsolute(value) || value.startsWith('/') || value.split('/').includes('..')) {
    throw new MhiFileError('mhi_glob_invalid', 'glob must be relative to the workspace.')
  }
  let source = '^'
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (char === '*') {
      if (value[i + 1] === '*') {
        const followedBySlash = value[i + 2] === '/'
        source += followedBySlash ? '(?:.*/)?' : '.*'
        i += followedBySlash ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegexChar(char)
    }
  }
  return new RegExp(source + '$', process.platform === 'win32' ? 'i' : '')
}

function globOperation(call, fileScope, signal) {
  assertActive(signal)
  const include = globRegex(call.params.pattern)
  const maximum = call.params.max || 100
  const basePath = call.params.dir
    ? fileScope.existingDirectory(call.params.dir).path
    : fileScope.rootPath
  const started = Date.now()
  const matches = []

  function visit(directory) {
    assertActive(signal)
    if (Date.now() - started > GREP_TIMEOUT_MS) {
      throw new MhiFileError('mhi_grep_timeout', 'glob timed out.')
    }
    if (matches.length >= maximum) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      assertActive(signal)
      if (matches.length >= maximum) return
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = path.join(directory, entry.name)
      const relative = path.relative(basePath, full).split(String.fromCharCode(0x5c)).join('/')
      let stat
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(full)
        continue
      }
      if (stat.isFile() && include.test(relative)) matches.push(relative)
    }
  }

  visit(basePath)
  return {
    relativePath: '.',
    output: matches.length === 0 ? 'No matches.' : boundedOutput(matches.join('\n')),
  }
}

function hasUnsafeRegexSyntax(source) {
  const BS = String.fromCharCode(0x5c)
  let escaped = false
  let inClass = false
  for (const char of source) {
    if (escaped) {
      if (!inClass && /[1-9]/.test(char)) return true
      escaped = false
      continue
    }
    if (char === BS) {
      escaped = true
      continue
    }
    if (char === '[' && !inClass) {
      inClass = true
      continue
    }
    if (char === ']' && inClass) {
      inClass = false
      continue
    }
    if (!inClass && '()*+?{}|'.includes(char)) return true
  }
  return false
}

function safeSearch(call) {
  if (call.params.query !== undefined) {
    const needle = call.params.query
    if (needle.length > 4096) throw new MhiFileError('mhi_query_too_large', 'Query too long.')
    return (line) => line.includes(needle)
  }
  const source = call.params.queryR
  if (source.length > 256) throw new MhiFileError('mhi_regex_too_large', 'Regex too long.')
  if (hasUnsafeRegexSyntax(source)) {
    throw new MhiFileError('mhi_regex_unsafe', 'Regex contains unsafe syntax.')
  }
  let regex
  try {
    regex = new RegExp(source, 'u')
  } catch (error) {
    throw new MhiFileError('mhi_regex_invalid', 'Invalid regex: ' + error.message)
  }
  return (line) => regex.test(line)
}

function grepOperation(call, fileScope, signal, options = {}) {
  const matcher = safeSearch(call)
  const include = globRegex(call.params.glob)
  const maximum = call.params.max || 100
  const context = options && options.context ? options.context : null
  const cwd = context && typeof context.cwd === 'string' && context.cwd !== '' ? context.cwd : null
  let basePath = fileScope.rootPath
  if (cwd) {
    try {
      basePath = fileScope.existingDirectory(cwd).path
    } catch {
      basePath = fileScope.rootPath
    }
  }
  const started = Date.now()
  let files = 0
  let totalBytes = 0
  const matches = []

  function visit(directory, isRoot = false) {
    assertActive(signal)
    if (Date.now() - started > GREP_TIMEOUT_MS) {
      throw new MhiFileError('mhi_grep_timeout', 'grep timed out.')
    }
    let safeDirectory
    try {
      safeDirectory = fileScope.existingDirectory(directory)
    } catch (error) {
      if (
        !isRoot &&
        error &&
        ['mhi_directory_not_found', 'mhi_not_a_directory'].includes(error.code)
      ) {
        return
      }
      throw error
    }
    let entries
    try {
      entries = fs.readdirSync(safeDirectory.path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      assertActive(signal)
      if (matches.length >= maximum) return
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = path.join(safeDirectory.path, entry.name)
      const relative = path.relative(basePath, full).split(String.fromCharCode(0x5c)).join('/')
      let stat
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(full)
        continue
      }
      if (!stat.isFile() || !include.test(relative)) continue
      let safeFile
      try {
        safeFile = fileScope.existingFile(full)
      } catch {
        continue
      }
      files += 1
      if (files > MAX_GREP_FILES)
        throw new MhiFileError('mhi_grep_file_limit', 'grep hit the file cap.')
      if (safeFile.stat.size > MAX_FILE_BYTES) continue
      totalBytes += safeFile.stat.size
      if (totalBytes > MAX_GREP_TOTAL_BYTES) {
        throw new MhiFileError('mhi_grep_size_limit', 'grep hit the byte cap.')
      }
      let text
      try {
        text = decodeUtf8(fs.readFileSync(safeFile.path))
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      lines.forEach((line, index) => {
        if (matches.length < maximum && matcher(line)) {
          matches.push(relative + ':' + (index + 1) + ': ' + line)
        }
      })
    }
  }

  visit(basePath, true)
  return {
    relativePath: '.',
    output: matches.length === 0 ? 'No matches.' : boundedOutput(matches.join('\n')),
  }
}

function writeOperation(call, fileScope, signal) {
  assertActive(signal)
  const target = fileScope.newFile(call.params.path)
  const bytes = Buffer.byteLength(call.params.content)
  if (bytes > MAX_FILE_BYTES) {
    throw new MhiFileError('mhi_write_too_large', 'Content exceeds ' + MAX_FILE_BYTES + ' bytes.')
  }
  assertActive(signal)
  atomicWrite(target.path, call.params.content, false)
  return {
    relativePath: target.relativePath,
    output: 'WRITTEN: ' + target.relativePath + ' (' + bytes + ' bytes)',
  }
}

function replaceOperation(call, fileScope, signal) {
  assertActive(signal)
  const file = fileScope.existingFile(call.params.path)
  const text = readText(file)
  if (call.params.old === call.params.new) {
    throw new MhiFileError('mhi_replace_identical', 'old and new are identical.')
  }
  let count = 0
  let cursor = 0
  for (;;) {
    const index = text.indexOf(call.params.old, cursor)
    if (index === -1) break
    count += 1
    cursor = index + call.params.old.length
  }
  if (count === 0) throw new MhiFileError('mhi_replace_not_found', 'old text not found.')
  if (count !== 1) {
    throw new MhiFileError(
      'mhi_replace_not_unique',
      'old text occurs ' + count + ' times; exactly one match is required.',
    )
  }
  const updated = text.replace(call.params.old, call.params.new)
  if (Buffer.byteLength(updated) > MAX_FILE_BYTES) {
    throw new MhiFileError(
      'mhi_write_too_large',
      'Updated content exceeds ' + MAX_FILE_BYTES + ' bytes.',
    )
  }
  assertActive(signal)
  atomicWrite(file.path, updated, true)
  return { relativePath: file.relativePath, output: 'UPDATED: ' + file.relativePath }
}

async function execute(call, options = {}) {
  try {
    const fileScope = scope(options)
    let result
    if (call.tool === 'read') result = readOperation(call, fileScope, options.signal)
    else if (call.tool === 'ls') result = lsOperation(call, fileScope, options.signal)
    else if (call.tool === 'glob') result = globOperation(call, fileScope, options.signal)
    else if (call.tool === 'grep') result = grepOperation(call, fileScope, options.signal, options)
    else if (call.tool === 'write') result = writeOperation(call, fileScope, options.signal)
    else if (call.tool === 'replace') result = replaceOperation(call, fileScope, options.signal)
    else throw new MhiFileError('mhi_unknown_tool', 'Unknown file tool: ' + call.tool)
    return {
      tool: call.tool,
      ok: true,
      relativePath: result.relativePath,
      output: boundedOutput(result.output),
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    const code = error && typeof error.code === 'string' ? error.code : 'mhi_file_error'
    const message = error && error.message ? error.message : 'Unknown file error.'
    return { tool: call.tool, ok: false, code, output: 'ERROR [' + code + '] ' + message }
  }
}

async function executeMany(calls, options = {}) {
  const results = []
  for (const call of calls) {
    assertActive(options.signal)
    try {
      results.push(await execute(call, options))
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      const code = error && typeof error.code === 'string' ? error.code : 'mhi_file_error'
      const message = error && error.message ? error.message : 'Unknown file error.'
      results.push({ tool: call.tool, ok: false, code, output: 'ERROR [' + code + '] ' + message })
    }
  }
  return results
}

function formatResults(results) {
  return results.map((r) => 'MHI(' + r.tool + '): ' + r.output).join('\n\n')
}

module.exports = {
  GREP_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_GREP_FILES,
  MAX_GREP_TOTAL_BYTES,
  MAX_OUTPUT_BYTES,
  atomicWrite,
  decodeUtf8,
  execute,
  executeMany,
  formatResults,
  globRegex,
  hasUnsafeRegexSyntax,
  safeSearch,
}
