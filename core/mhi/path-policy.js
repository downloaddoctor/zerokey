'use strict'

/**
 * Path policy for the internal executors.
 *
 * Refuses: absolute paths outside the workspace, UNC paths, device paths,
 * alternate data streams, reserved Windows names, trailing dot/space in a
 * segment, and anything whose real (junction-resolved) parent escapes the
 * workspace root.
 */

const fs = require('fs')
const path = require('path')

const MAX_PATH_CHARS = 4096
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

class MhiFileError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MhiFileError'
    this.code = code
  }
}

function isUnc(value) {
  const text = String(value || '')
  const slash = '/'.charCodeAt(0)
  const backslash = 0x5c
  if (text.length < 2) return false
  const a = text.charCodeAt(0)
  const b = text.charCodeAt(1)
  const twoSlashes = (a === slash || a === backslash) && (b === slash || b === backslash)
  if (twoSlashes) return true
  const prefix =
    String.fromCharCode(backslash) +
    String.fromCharCode(backslash) +
    '?' +
    String.fromCharCode(backslash) +
    'UNC' +
    String.fromCharCode(backslash)
  return text.startsWith(prefix)
}

function normalizeCase(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function realPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value)
  } catch (caughtErr) {
    console.error('path-policy: realpath failed:', caughtErr)
    return null
  }
}

function assertWindowsSyntax(supplied) {
  if (supplied.includes('\0')) {
    throw new MhiFileError('mhi_path_invalid', 'Path contains a NUL byte.')
  }
  if (isUnc(supplied)) {
    throw new MhiFileError('mhi_path_unc_forbidden', 'UNC and device paths are not allowed.')
  }
  {
    const BS = String.fromCharCode(0x5c)
    if (supplied.startsWith(BS + BS + '?.') || supplied.startsWith(BS + BS + '?')) {
      throw new MhiFileError('mhi_path_unc_forbidden', 'UNC and device paths are not allowed.')
    }
  }
  const parsed = path.parse(supplied)
  const remainder = supplied.slice(parsed.root.length)
  if (remainder.includes(':')) {
    throw new MhiFileError('mhi_path_ads_forbidden', 'Alternate data streams are not allowed.')
  }
  const BS = String.fromCharCode(0x5c)
  const segments = remainder.split(BS).join('/').split('/')
  for (const segment of segments) {
    if (segment === '') continue
    const lastCode = segment.charCodeAt(segment.length - 1)
    if (lastCode === 0x20 || lastCode === 0x2e) {
      throw new MhiFileError('mhi_path_invalid', 'Path segments may not end with dot or space.')
    }
    const device = segment.split('.')[0]
    if (RESERVED.test(device)) {
      throw new MhiFileError('mhi_path_reserved', 'Reserved Windows device name.')
    }
  }
}

function scope(options) {
  const context = options && options.context
  const suppliedRoot =
    context && typeof context.rootPath === 'string' ? path.resolve(context.rootPath) : null
  const rootPath = suppliedRoot ? realPath(suppliedRoot) : null
  if (!rootPath) {
    throw new MhiFileError(
      'mhi_workspace_required',
      'The internal executors need a resolved workspace root.',
    )
  }
  const rootCompare = normalizeCase(rootPath)
  const suppliedRootCompare = normalizeCase(suppliedRoot)

  function lexical(supplied) {
    if (typeof supplied !== 'string' || supplied.trim() === '') {
      throw new MhiFileError('mhi_path_invalid', 'An absolute path is required.')
    }
    const value = supplied.trim()
    if (value.length > MAX_PATH_CHARS) {
      throw new MhiFileError('mhi_path_too_long', 'Path is too long.')
    }
    if (!path.isAbsolute(value)) {
      throw new MhiFileError('mhi_path_not_absolute', 'Path must be absolute.')
    }
    assertWindowsSyntax(value)
    const resolved = path.resolve(value)
    const resolvedCompare = normalizeCase(resolved)
    let inWorkspace =
      isWithin(rootCompare, resolvedCompare) || isWithin(suppliedRootCompare, resolvedCompare)
    if (!inWorkspace) {
      const resolvedReal = realPath(resolved)
      if (resolvedReal) inWorkspace = isWithin(rootCompare, normalizeCase(resolvedReal))
    }
    if (!inWorkspace) {
      const parentReal = realPath(path.dirname(resolved))
      if (parentReal) inWorkspace = isWithin(rootCompare, normalizeCase(parentReal))
    }
    if (!inWorkspace) {
      throw new MhiFileError('mhi_path_outside_workspace', 'Path is outside the workspace root.')
    }
    return resolved
  }

  function relative(candidate) {
    const candidateCompare = normalizeCase(candidate)
    const base = isWithin(rootCompare, candidateCompare) ? rootPath : suppliedRoot
    return (path.relative(base, candidate) || '.').split(String.fromCharCode(0x5c)).join('/')
  }

  function existingDirectory(supplied) {
    const candidate = lexical(supplied)
    const real = realPath(candidate)
    if (!real) throw new MhiFileError('mhi_directory_not_found', 'Directory not found.')
    if (!isWithin(rootCompare, normalizeCase(real))) {
      throw new MhiFileError('mhi_path_escape', 'Real path escapes the workspace root.')
    }
    const stat = fs.statSync(real)
    if (!stat.isDirectory()) throw new MhiFileError('mhi_not_a_directory', 'Not a directory.')
    return { path: real, relativePath: relative(real), stat }
  }

  function existingFile(supplied) {
    const candidate = lexical(supplied)
    const real = realPath(candidate)
    if (!real) throw new MhiFileError('mhi_file_not_found', 'File not found.')
    if (!isWithin(rootCompare, normalizeCase(real))) {
      throw new MhiFileError('mhi_path_escape', 'Real path escapes the workspace root.')
    }
    const stat = fs.statSync(real)
    if (!stat.isFile()) throw new MhiFileError('mhi_not_a_file', 'Not a regular file.')
    return { path: real, relativePath: relative(real), stat }
  }

  function newFile(supplied) {
    const candidate = lexical(supplied)
    try {
      fs.lstatSync(candidate)
      throw new MhiFileError('mhi_file_exists', 'write creates new files only.')
    } catch (error) {
      console.error('fs.lstatSync() failed:', error)
      if (error instanceof MhiFileError) throw error
      if (!error || error.code !== 'ENOENT') {
        throw new MhiFileError('mhi_path_unreadable', 'Target path could not be checked.')
      }
    }
    const parent = realPath(path.dirname(candidate))
    if (!parent) throw new MhiFileError('mhi_parent_not_found', 'Parent directory not found.')
    if (!isWithin(rootCompare, normalizeCase(parent))) {
      throw new MhiFileError('mhi_path_escape', 'Real parent escapes the workspace root.')
    }
    const stat = fs.statSync(parent)
    if (!stat.isDirectory()) {
      throw new MhiFileError('mhi_parent_not_directory', 'Parent is not a directory.')
    }
    return { path: candidate, relativePath: relative(candidate), parent }
  }

  return { existingDirectory, existingFile, newFile, rootPath }
}

module.exports = { MhiFileError, MAX_PATH_CHARS, assertWindowsSyntax, isWithin, isUnc, scope }
