'use strict'

/**
 * Bounded command executor.
 *
 * Two positive lists:
 *   - named programs, resolved under a trusted Windows root
 *   - project programs and scripts, resolved inside the workspace
 *
 * Capability flags are separate: allowWrite and allowNetwork default off.
 * Programs that need either flag are refused unless the flag is on.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { scope, isWithin } = require('./path-policy')

const DEFAULT_PROGRAMS = ['node', 'git']
const HARD_DENY = new Set([])

const SAFE_ENVIRONMENT = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
]

const MAX_ARGUMENTS = 128
const MAX_ARGUMENT_CHARS = 4096
const MAX_ARGUMENT_TOTAL_CHARS = 32768
const MAX_PROGRAM_CHARS = 128
const MAX_TIMEOUT_MS = 120000
const DEFAULT_TIMEOUT_MS = 30000
const MAX_OUTPUT_BYTES = 64 * 1024

class MhiCommandError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MhiCommandError'
    this.code = code
  }
}

function abortError() {
  const error = new Error('MHI command aborted.')
  error.name = 'AbortError'
  error.code = 'mhi_cmd_aborted'
  return error
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.(?:exe|com)$/i, '')
}

function normalizeList(value, fallback = []) {
  const list = Array.isArray(value) ? value : fallback
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))]
}

function parseArguments(raw) {
  if (raw === undefined || raw === '') return []
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (caughtErr) {
      console.error('JSON.parse() failed:', caughtErr)
      throw new MhiCommandError('mhi_cmd_args_invalid', 'args must be a JSON array of strings.')
    }
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new MhiCommandError('mhi_cmd_args_invalid', 'args must be a JSON array of strings.')
  }
  if (value.length > MAX_ARGUMENTS) {
    throw new MhiCommandError('mhi_cmd_args_too_many', 'Too many arguments.')
  }
  let total = 0
  for (const item of value) {
    if (item.includes('\0')) {
      throw new MhiCommandError('mhi_cmd_arg_invalid', 'Arguments may not contain NUL.')
    }
    if (item.length > MAX_ARGUMENT_CHARS) {
      throw new MhiCommandError('mhi_cmd_arg_too_large', 'An argument is too long.')
    }
    total += item.length
  }
  if (total > MAX_ARGUMENT_TOTAL_CHARS) {
    throw new MhiCommandError('mhi_cmd_args_too_large', 'Arguments total too large.')
  }
  return [...value]
}

function environmentValue(name) {
  const wanted = name.toLowerCase()
  const found = Object.keys(process.env).find((key) => key.toLowerCase() === wanted)
  return found ? process.env[found] : undefined
}

function safeEnvironment(program) {
  const env = {}
  for (const name of SAFE_ENVIRONMENT) {
    const value = environmentValue(name)
    if (value !== undefined) env[name] = value
  }
  env.CI = '1'
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  if (normalizeName(program) === 'git') {
    const emptyHooks = path.join(os.tmpdir(), 'zerokey-empty-git-hooks')
    fs.mkdirSync(emptyHooks, { recursive: true })
    env.GIT_CONFIG_GLOBAL = 'NUL'
    env.GIT_CONFIG_SYSTEM = 'NUL'
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_ASKPASS = ''
    env.GIT_PAGER = ''
    env.GIT_EDITOR = ''
    env.GIT_EXTERNAL_DIFF = ''
    env.GIT_OPTIONAL_LOCKS = '0'
    env.ZEROKEY_GIT_HOOKS = emptyHooks
  }
  return env
}

function ensureProgramToken(program) {
  if (typeof program !== 'string' || program.trim() === '') {
    throw new MhiCommandError('mhi_cmd_program_required', 'A program name is required.')
  }
  const value = program.trim()
  if (value.length > MAX_PROGRAM_CHARS || value.includes('\0')) {
    throw new MhiCommandError('mhi_cmd_program_invalid', 'Program name is invalid.')
  }
  return value
}

function realPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value)
  } catch (caughtErr) {
    console.error('commands: realpath failed:', caughtErr)
    return null
  }
}

function trustedNamedRoots() {
  const values = [
    path.dirname(process.execPath),
    environmentValue('SystemRoot'),
    environmentValue('WINDIR'),
    environmentValue('ProgramFiles'),
    environmentValue('ProgramFiles(x86)'),
  ]
    .filter(Boolean)
    .map((value) => realPath(value) || path.resolve(value))
  return [...new Set(values)]
}

function isTrustedNamedProgram(candidate) {
  return trustedNamedRoots().some((root) => isWithin(root, candidate))
}

function resolveNamedProgram(requested, fileScope, programs) {
  const name = normalizeName(requested)
  if (HARD_DENY.has(name)) {
    throw new MhiCommandError('mhi_cmd_program_hard_denied', 'This program is blocked.')
  }
  const allowed = programs.map(normalizeName)
  if (!allowed.includes(name)) {
    throw new MhiCommandError('mhi_cmd_program_forbidden', 'Program is not in the allowlist.')
  }

  if (name === 'node') {
    const executable = realPath(process.execPath) || process.execPath
    return { requested, executable, name, project: false }
  }

  const systemRoot = environmentValue('SystemRoot') || environmentValue('WINDIR')
  if (!systemRoot || process.platform !== 'win32') {
    throw new MhiCommandError('mhi_cmd_program_not_found', 'The allowed program was not found.')
  }

  const where = path.join(systemRoot, 'System32', 'where.exe')
  const found = spawnSync(where, [requested], {
    cwd: systemRoot,
    env: safeEnvironment(requested),
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
    shell: false,
  })
  const candidates = String(found.stdout || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /\.(?:exe|com)$/i.test(item))

  for (const candidate of candidates) {
    const executable = realPath(candidate)
    if (!executable) continue
    if (!isTrustedNamedProgram(executable)) continue
    return { requested, executable, name, project: false }
  }
  throw new MhiCommandError('mhi_cmd_program_not_found', 'No native EXE/COM found for this name.')
}

function resolveProjectProgram(requested, fileScope, projectPrograms) {
  if (path.isAbsolute(requested)) {
    throw new MhiCommandError('mhi_cmd_program_invalid', 'Project programs must be relative paths.')
  }
  const BS = String.fromCharCode(0x5c)
  const normalized = requested.split(BS).join('/')
  const allowed = projectPrograms.map((item) => item.split(BS).join('/'))
  const compare = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const found = allowed.find((item) => {
    const candidate = process.platform === 'win32' ? item.toLowerCase() : item
    return candidate === compare
  })
  if (!found)
    throw new MhiCommandError('mhi_cmd_program_forbidden', 'Project program is not allowlisted.')

  const file = fileScope.existingFile(path.resolve(fileScope.rootPath, normalized))
  if (!/\.(?:exe|com)$/i.test(file.path)) {
    throw new MhiCommandError(
      'mhi_cmd_program_type_forbidden',
      'Project programs must be EXE or COM.',
    )
  }
  return {
    requested: normalized,
    executable: file.path,
    name: normalizeName(path.basename(file.path)),
    project: true,
  }
}

function resolveProgram(program, fileScope, options = {}) {
  const requested = ensureProgramToken(program)
  const programs = normalizeList(options.programs, DEFAULT_PROGRAMS)
  const projectPrograms = normalizeList(options.projectPrograms)
  if (/[\\/]/.test(requested) || requested.startsWith('.')) {
    return resolveProjectProgram(requested, fileScope, projectPrograms)
  }
  return resolveNamedProgram(requested, fileScope, programs)
}

function gitSubcommand(args) {
  if (args.length === 0) return ''
  if (args[0].startsWith('-')) return ''
  return args[0].toLowerCase()
}

function classifyCapabilities(program, args, project) {
  const name = normalizeName(program)
  if (project) return { write: true, network: true }
  if (name === 'node') {
    if (args.length === 2 && args[0] === '--check') {
      return { write: false, network: false, nodeCheck: true }
    }
    return { write: true, network: true }
  }
  if (name === 'git') {
    const subcommand = gitSubcommand(args)
    const readOnly = ['status', 'rev-parse', 'ls-files', 'log', 'diff', 'show'].includes(subcommand)
    return { write: !readOnly, network: !readOnly, git: true }
  }
  return { write: true, network: true }
}

function assertCapabilities(capabilities, options) {
  if (capabilities.write && options.allowWrite !== true) {
    throw new MhiCommandError('mhi_cmd_write_forbidden', 'This command needs allowWrite.')
  }
  if (capabilities.network && options.allowNetwork !== true) {
    throw new MhiCommandError('mhi_cmd_network_forbidden', 'This command needs allowNetwork.')
  }
}

function prepareArguments(resolved, args, fileScope, capabilities, _options) {
  const prepared = [...args]
  if (capabilities.nodeCheck) {
    const file = fileScope.existingFile(prepared[1])
    if (!/\.(?:cjs|mjs|js)$/i.test(file.path)) {
      throw new MhiCommandError('mhi_cmd_node_check_type', 'node --check accepts JS files only.')
    }
    prepared[1] = file.path
  }
  if (resolved.name === 'git') {
    const hooks = safeEnvironment('git').ZEROKEY_GIT_HOOKS
    return [
      '--no-pager',
      '-c',
      'core.hooksPath=' + hooks,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'diff.external=',
      '-c',
      'credential.helper=',
      ...prepared,
    ]
  }
  return prepared
}

function outputLimit(value, maximum) {
  const text = String(value)
  if (Buffer.byteLength(text) <= maximum) return text
  const suffix = '\n[output capped at ' + maximum + ' bytes]'
  const available = Math.max(0, maximum - Buffer.byteLength(suffix))
  let end = Math.min(text.length, available)
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > available) end -= 1
  return text.slice(0, end) + suffix
}

function outputCollector(shared) {
  const kept = []
  return {
    push(chunk) {
      const buffer = Buffer.from(chunk)
      if (shared.remaining > 0) {
        const count = Math.min(shared.remaining, buffer.length)
        if (count > 0) kept.push(buffer.subarray(0, count))
        shared.remaining -= count
        if (count < buffer.length) shared.truncated = true
      } else {
        shared.truncated = true
      }
    },
    finish() {
      return Buffer.concat(kept).toString('utf8')
    },
  }
}

function terminatePidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve()
  if (process.platform === 'win32') {
    const systemRoot = environmentValue('SystemRoot') || environmentValue('WINDIR') || 'C:\\Windows'
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      let killer
      try {
        killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
          env: safeEnvironment('taskkill'),
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        })
      } catch (caughtErr) {
        console.error('spawn() failed:', caughtErr)
        try {
          process.kill(pid, 'SIGKILL')
        } catch (caughtErr) {
          console.error('process.kill() failed:', caughtErr)
        }
        done()
        return
      }
      killer.once('error', () => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (caughtErr) {
          console.error('process.kill() failed:', caughtErr)
        }
        done()
      })
      killer.once('close', done)
      setTimeout(done, 3000).unref()
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (caughtErr) {
    console.error('process.kill() failed:', caughtErr)
    try {
      process.kill(pid, 'SIGKILL')
    } catch (caughtErr) {
      console.error('process.kill() failed:', caughtErr)
    }
  }
  return Promise.resolve()
}

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return null
  const systemRoot = environmentValue('SystemRoot') || environmentValue('WINDIR') || 'C:\\Windows'
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const script =
    '$p=Get-Process -Id ' +
    String(pid) +
    ' -ErrorAction SilentlyContinue; if($null -eq $p){exit 3}; ' +
    '$o=[pscustomobject]@{' +
    'started_at=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds();' +
    'executable=$p.Path' +
    '}; [Console]::Out.Write(($o | ConvertTo-Json -Compress))'
  let result
  try {
    result = spawnSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: safeEnvironment('powershell'),
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        shell: false,
      },
    )
  } catch (caughtErr) {
    console.error('spawnSync() failed:', caughtErr)
    return null
  }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return null
  try {
    const parsed = JSON.parse(result.stdout)
    const startedAt = Number(parsed && parsed.started_at)
    const executable =
      parsed && typeof parsed.executable === 'string' && parsed.executable.trim() !== ''
        ? realPath(parsed.executable) || path.resolve(parsed.executable)
        : null
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || executable === null) return null
    return { startedAt, executable }
  } catch (caughtErr) {
    console.error('JSON.parse() failed:', caughtErr)
    return null
  }
}

function terminateTree(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) {
    return Promise.resolve()
  }
  return terminatePidTree(child.pid)
}

function prepareExecution(call, options = {}) {
  if (options.enabled !== true) {
    throw new MhiCommandError('mhi_cmd_disabled', 'Controlled command execution is not enabled.')
  }
  const fileScope = scope(options)
  const cwd = fileScope.existingDirectory(call.params.cwd || fileScope.rootPath)
  const args = parseArguments(call.params.args)
  const resolved = resolveProgram(call.params.program, fileScope, options)
  const capabilities = classifyCapabilities(resolved.name, args, resolved.project)
  assertCapabilities(capabilities, options)
  const prepared = prepareArguments(resolved, args, fileScope, capabilities, options)
  return { resolved, args: prepared, cwd: cwd.path, cwdRelative: cwd.relativePath, capabilities }
}

function runProcess(resolved, args, cwd, options) {
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
  )
  const maximumOutput = Math.min(
    MAX_OUTPUT_BYTES,
    Math.max(1024, Number(options.maxOutputBytes) || MAX_OUTPUT_BYTES),
  )
  return new Promise((resolve, reject) => {
    const shared = { remaining: maximumOutput, truncated: false }
    const stdout = outputCollector(shared)
    const stderr = outputCollector(shared)
    let child
    let reason = null
    let settled = false
    let timer = null
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(result)
    }
    const requestStop = async (nextReason) => {
      if (settled || reason) return
      reason = nextReason
      await terminateTree(child)
      setTimeout(() => {
        if (reason === 'abort') finish(abortError())
        else finish(new MhiCommandError('mhi_cmd_timeout', 'Command timed out.'))
      }, 250).unref()
    }
    const onAbort = () => {
      void requestStop('abort')
    }
    if (options.signal && options.signal.aborted) {
      finish(abortError())
      return
    }
    try {
      child = spawn(resolved.executable, args, {
        cwd,
        env: safeEnvironment(resolved.name),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      console.error('spawn() failed:', error)
      finish(new MhiCommandError('mhi_cmd_spawn_failed', 'Could not start: ' + error.message))
      return
    }
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => {
      finish(new MhiCommandError('mhi_cmd_spawn_failed', 'Could not start: ' + error.message))
    })
    child.once('close', (code, signalName) => {
      if (reason === 'abort') {
        finish(abortError())
        return
      }
      if (reason === 'timeout') {
        finish(new MhiCommandError('mhi_cmd_timeout', 'Command timed out.'))
        return
      }
      finish(null, {
        exitCode: Number.isInteger(code) ? code : null,
        signal: signalName || null,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        truncated: shared.truncated,
        maximumOutput,
      })
    })
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      void requestStop('timeout')
    }, timeoutMs)
  })
}

function commandOutput(resolved, result) {
  const lines = [
    'PROGRAM: ' + resolved.requested,
    'EXIT: ' + (result.exitCode === null ? 'null' : result.exitCode),
    'STDOUT:',
    result.stdout === '' ? '(empty)' : result.stdout,
    'STDERR:',
    result.stderr === '' ? '(empty)' : result.stderr,
  ]
  if (result.truncated) lines.push('[output truncated]')
  return outputLimit(lines.join('\n'), result.maximumOutput)
}

async function execute(call, options = {}) {
  try {
    const preparedExecution = prepareExecution(call, options)
    const timeoutMs = call.params.timeout !== undefined ? call.params.timeout : options.timeoutMs
    const result = await runProcess(
      preparedExecution.resolved,
      preparedExecution.args,
      preparedExecution.cwd,
      { signal: options.signal, timeoutMs, maxOutputBytes: options.maxOutputBytes },
    )
    const output = commandOutput(preparedExecution.resolved, result)
    if (result.exitCode !== 0) {
      return { tool: 'cmd', ok: false, code: 'mhi_cmd_exit', output }
    }
    return { tool: 'cmd', ok: true, output }
  } catch (error) {
    console.error('prepareExecution() failed:', error)
    if (error && error.name === 'AbortError') throw error
    const code = error && typeof error.code === 'string' ? error.code : 'mhi_cmd_error'
    const message = error && error.message ? error.message : 'Unknown command error.'
    return { tool: 'cmd', ok: false, code, output: 'ERROR [' + code + '] ' + message }
  }
}

module.exports = {
  MhiCommandError,
  DEFAULT_PROGRAMS,
  DEFAULT_TIMEOUT_MS,
  HARD_DENY,
  MAX_ARGUMENTS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  classifyCapabilities,
  execute,
  outputLimit,
  parseArguments,
  prepareExecution,
  processIdentity,
  resolveProgram,
  safeEnvironment,
  terminatePidTree,
  terminateTree,
}
