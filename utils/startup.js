'use strict'

/**
 * Startup hygiene: single-instance lock, duplicate-listener probes, and
 * port selection driven by the lock file.
 *
 * Multiple ZeroKey instances share temp/db/zerokey.db (users and sessions).
 * Each instance owns one port and one lock file: temp/db/.start.<port>.lock.
 * The lock file is the source of truth for "this port belongs to an
 * instance of this data root". The OS probe is only used to catch the race
 * between a claim and a live bind.
 *
 * The lock carries { pid, port, startedAt }. claimFirstFree() walks ports
 * from `start`, taking the first whose lock file is absent or whose owner
 * PID is dead. On a live lock it moves on (or throws when `exact` is set).
 *
 * Three stages of defence within one port:
 *   1. Post-claim /health probe - catches a listener that is answering even
 *      though no lock file matches it (foreign process, hard crash).
 *   2. PID lock via exclusive create ('wx') - catches a start that has not
 *      yet reached the listening state.
 *   3. Foreign-owner comparison - /health reports a different PID than the
 *      lock does, so the listener is not ours.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
const { CONFIG } = require('../config/constants')

const PROBE_TIMEOUT_MS = 2000

function lockFileFor(port) {
  return path.join(path.dirname(CONFIG.LOCK_FILE), `.start.${port}.lock`)
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: CONFIG.HOST, port, path: '/health', timeout: PROBE_TIMEOUT_MS },
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

function isPortActive(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(400)
    sock
      .once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      .once('error', () => {
        sock.destroy()
        resolve(false)
      })
      .once('timeout', () => {
        sock.destroy()
        resolve(false)
      })
      .connect(port, CONFIG.HOST)
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

function readLock(port) {
  try {
    const data = JSON.parse(fs.readFileSync(lockFileFor(port), 'utf8'))
    return Number.isInteger(data.pid) ? data : null
  } catch {
    return null
  }
}

function healthBelongsToThisInstance(health, port) {
  if (!health || !Number.isInteger(health.pid) || health.pid <= 0) return false
  const lock = readLock(port)
  return (
    lock !== null &&
    Number.isInteger(lock.pid) &&
    lock.pid === health.pid &&
    Number.isInteger(lock.port) &&
    lock.port === port
  )
}

/**
 * Claim `port` for this process.
 *
 * @returns {'taken' | 'busy'}
 *   taken - the lock file now belongs to this PID
 *   busy  - a live process holds it, or the retry after clearing an orphan
 *           was beaten to it
 */
function acquire(port) {
  const file = lockFileFor(port)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2) +
          '\n',
      )
      fs.closeSync(fd)
      return 'taken'
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      const lock = readLock(port)
      if (lock !== null && lock.pid !== process.pid && pidAlive(lock.pid)) return 'busy'

      console.warn(
        `Removed orphaned start lock for port ${port} (PID ${
          lock === null ? 'unreadable' : lock.pid
        }).`,
      )
      try {
        fs.unlinkSync(file)
      } catch {}
      // Loop again; the next iteration tries the exclusive create fresh.
    }
  }
  return 'busy'
}

function release(port) {
  const lock = readLock(port)
  if (lock === null || lock.pid !== process.pid) return
  try {
    fs.unlinkSync(lockFileFor(port))
  } catch {}
}

/**
 * Walk ports from `start` and claim the first whose lock file is absent or
 * orphaned. On a busy lock, moves to the next port unless `exact` is set.
 *
 * @returns {Promise<number>} the claimed port
 */
async function claimFirstFree(options = {}) {
  const start = Number.isInteger(options.start) ? options.start : CONFIG.PORT
  const range = Number.isInteger(options.range) ? options.range : CONFIG.PORT_RANGE
  const exact = options.exact === true

  for (let port = start; port <= start + range; port += 1) {
    if (acquire(port) === 'taken') return port
    if (exact) {
      const error = new Error(
        `Port ${start} is busy and ZEROKEY_EXACT_PORT is on. A silently relocated ` +
          'listener would be worse than a refused start.',
      )
      error.code = 'EADDRINUSE'
      throw error
    }
  }

  const error = new Error(`No free port in ${start}..${start + range} on ${CONFIG.HOST}.`)
  error.code = 'ENOPORT'
  throw error
}

/**
 * Post-claim verification: is a foreign listener answering on the port we
 * just claimed? Called after claimFirstFree, before app.listen.
 *
 * @returns {Promise<{ ok: true }>}
 * @throws when a listener is answering that is not proven to be ours
 */
async function postClaim(port) {
  const running = await probeHealth(port)
  if (running === null) return { ok: true }
  if (healthBelongsToThisInstance(running, port)) return { ok: true }

  release(port)
  throw new Error(
    `A listener is answering on port ${port} but is not proven to be this data ` +
      "root's ZeroKey instance. Foreign listener ownership is not taken over.",
  )
}

module.exports = {
  isPortActive,
  acquire,
  claimFirstFree,
  healthBelongsToThisInstance,
  lockFileFor,
  pidAlive,
  postClaim,
  probeHealth,
  readLock,
  release,
  PROBE_TIMEOUT_MS,
}
