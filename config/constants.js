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

  // A busy port is an error, not a reason to wander. Callers that want the old
  // fallback behaviour must opt in explicitly.
  EXACT_PORT: process.env.ZEROKEY_EXACT_PORT !== '0',

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

CONFIG.DB_FILE = path.join(CONFIG.DATA_DIR, 'zerokey.db')
CONFIG.LOCK_FILE = path.join(CONFIG.DATA_DIR, '.start.lock')
CONFIG.LOG_DIR = path.join(CONFIG.DATA_DIR, 'logs')

module.exports = { CONFIG }
