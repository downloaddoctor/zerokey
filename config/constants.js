/**
 * Application constants and configuration.
 *
 * Read once at require-time. Changing any value takes effect only on restart.
 */

const path = require('path')

function envInt(name, fallback, minimum, maximum) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(name + ' must be a positive integer, got: ' + raw)
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' is out of range [' + minimum + ', ' + maximum + ']: ' + raw)
  }
  return value
}

const CONFIG = {
  PORT: envInt('PORT', 7250, 1, 65535),

  EXACT_PORT: process.env.ZEROKEY_EXACT_PORT === '1',

  // State lives next to the code, outside the git-tracked tree. `temp/` is
  // already gitignored in this repo.
  DATA_DIR: process.env.ZEROKEY_DATA_DIR
    ? path.resolve(process.env.ZEROKEY_DATA_DIR)
    : path.resolve(__dirname, '..', 'temp'),

  HOST: '127.0.0.1',

  LOG_LEVEL: process.env.ZEROKEY_LOG_LEVEL || 'info',
  LOG_MAX_BYTES: envInt('ZEROKEY_LOG_MAX_BYTES', 5 * 1024 * 1024, 4096, 1024 * 1024 * 1024),
  LOG_KEEP: envInt('ZEROKEY_LOG_KEEP', 5, 1, 100),
}

function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = String(raw).trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'yes') return true
  if (value === '0' || value === 'false' || value === 'no') return false
  throw new Error(name + ' is not a switch: ' + raw)
}

function envPaths(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return [...fallback]
  return raw
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value !== '')
}

function envList(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return [...fallback]
  return raw
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter((value) => value !== '')
}

CONFIG.DB_FILE = path.join(CONFIG.DATA_DIR, 'db', 'zerokey.db')
CONFIG.LOCK_FILE = path.join(CONFIG.DATA_DIR, 'db', '.start.lock')
CONFIG.LOG_DIR = path.join(CONFIG.DATA_DIR, 'logs')

// Internal MHI executors. Each running process is pinned to one workspace
// root and one set of capability flags; nothing here is per-request.
CONFIG.WORKSPACE_ROOTS = envPaths('ZEROKEY_WORKSPACE_ROOTS', [process.cwd()])
CONFIG.MHI_FILE_TOOLS = envBool('ZEROKEY_MHI_FILE_TOOLS', true)
CONFIG.MHI_CMD_TOOLS = envBool('ZEROKEY_MHI_CMD_TOOLS', false)
CONFIG.MHI_VIEW_IMAGE = envBool('ZEROKEY_MHI_VIEW_IMAGE', true)
CONFIG.MHI_CMD_PROGRAMS = envList('ZEROKEY_MHI_CMD_PROGRAMS', ['node', 'git'])
CONFIG.MHI_CMD_PROJECT_PROGRAMS = envList('ZEROKEY_MHI_CMD_PROJECT_PROGRAMS', [])
CONFIG.MHI_CMD_ALLOW_WRITE = envBool('ZEROKEY_MHI_CMD_ALLOW_WRITE', false)
CONFIG.MHI_CMD_ALLOW_NETWORK = envBool('ZEROKEY_MHI_CMD_ALLOW_NETWORK', false)
CONFIG.MHI_CMD_TIMEOUT_MS = envInt('ZEROKEY_MHI_CMD_TIMEOUT_MS', 30000, 100, 120000)
CONFIG.MHI_MAX_ROUNDS = envInt('ZEROKEY_MHI_MAX_ROUNDS', 8, 1, 32)

module.exports = { CONFIG }
