'use strict'

/**
 * Startup hygiene: single-instance lock and duplicate-listener probing.
 *
 * Three stages of defence, because each alone has a gap:
 *
 *   1. Pre-flight /health probe - catches a running listener even if the
 *      lock file was lost (hard crash, manual delete).
 *   2. PID lock via exclusive create ('wx') - catches a start that has not
 *      yet reached the listening state, which the probe cannot see.
 *   3. Post-lock /health probe - catches the race where another process
 *      finished between (1) and the lock claim.
 *
 * A second invocation exits with code 0 and no noise. That is the normal
 * case for a double-click, not an error.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { CONFIG } = require('../config/constants')
const log = require('./log')

const PROBE_TIMEOUT_MS = 2000

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: CONFIG.HOST, port: CONFIG.PORT, path: '/health', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null)
          try {
            return resolve(JSON.parse(text))
          } catch {
            return resolve(null)
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readLock() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.LOCK_FILE, 'utf8'))
    return Number.isInteger(data.pid) ? data : null
  } catch {
    return null
  }
}

function healthBelongsToThisInstance(health) {
  if (!health || !Number.isInteger(health.pid) || health.pid <= 0) return false
  const lock = readLock()
  return (
    lock !== null &&
    Number.isInteger(lock.pid) &&
    lock.pid === health.pid &&
    Number.isInteger(lock.port) &&
    lock.port === CONFIG.PORT
  )
}

function acquire() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(CONFIG.LOCK_FILE), { recursive: true })
      const fd = fs.openSync(CONFIG.LOCK_FILE, 'wx')
      fs.writeSync(
        fd,
        JSON.stringify(
          { pid: process.pid, port: CONFIG.PORT, startedAt: new Date().toISOString() },
          null,
          2,
        ) + '\n',
      )
      fs.closeSync(fd)
      return 'taken'
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      const lock = readLock()
      if (lock !== null && lock.pid !== process.pid && pidAlive(lock.pid)) return 'busy'

      log.warn(
        'Removed orphaned start lock (PID ' + (lock === null ? 'unreadable' : lock.pid) + ').',
      )
      fs.unlinkSync(CONFIG.LOCK_FILE)
    }
  }
  return 'busy'
}

function release() {
  const lock = readLock()
  if (lock === null || lock.pid !== process.pid) return
  try {
    fs.unlinkSync(CONFIG.LOCK_FILE)
  } catch {}
}

/**
 * Full pre-flight. Returns one of:
 *   { ok: true, claimed: true }   - lock held by this process; caller proceeds
 *   { ok: true, claimed: false, running: <health> } - this instance already up
 *   { ok: true, claimed: false, busy: true }        - another start holds the lock
 * Throws on a foreign listener.
 */
async function preflight() {
  const running = await probeHealth()
  if (running !== null) {
    if (!healthBelongsToThisInstance(running)) {
      throw new Error(
        'A listener is answering on the configured port but is not proven to be this ' +
          "data root's ZeroKey instance. Refusing to take over its ownership.",
      )
    }
    log.info(
      'ZeroKey is already running (PID ' +
        running.pid +
        ', status ' +
        running.status +
        '). This start has no effect.',
    )
    return { ok: true, claimed: false, running }
  }

  if (acquire() === 'busy') {
    log.info('Another start holds the lock. This start has no effect.')
    return { ok: true, claimed: false, busy: true }
  }

  const raced = await probeHealth()
  if (raced !== null) {
    release()
    throw new Error(
      'During lock acquisition PID ' +
        raced.pid +
        ' started answering on the port. ' +
        'Foreign listener ownership is not taken over.',
    )
  }

  return { ok: true, claimed: true }
}

module.exports = {
  acquire,
  healthBelongsToThisInstance,
  pidAlive,
  preflight,
  probeHealth,
  readLock,
  release,
  PROBE_TIMEOUT_MS,
}
