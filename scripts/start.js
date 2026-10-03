'use strict'

/**
 * Authoritative starter. server.js is loaded from here, never run directly.
 *
 * Three stages of duplicate-listener defence, because each alone has a gap:
 *
 *   1. Pre-flight /health probe — catches a running listener even if the
 *      lock file was lost (hard crash, manual delete).
 *   2. PID lock via exclusive create ('wx') — catches a start that has not
 *      yet reached the listening state, which the probe cannot see.
 *   3. Post-lock /health probe — catches the race where another process
 *      finished between (1) and the lock claim.
 *
 * A second invocation exits with code 0 and no noise. That is the normal
 * case for a double-click, not an error.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { CONFIG } = require('../config/constants')
const log = require('../utils/log')
const db = require('../core/state/db')

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

async function main() {
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
    return 0
  }

  if (acquire() === 'busy') {
    log.info('Another start holds the lock. This start has no effect.')
    return 0
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

  const store = db.open()

  // Wizard runs only at a real terminal. Headless startup uses env vars
  // (ZEROKEY_PROVIDER / ZEROKEY_USER / ZEROKEY_SESSION) and skips the prompts.
  const { SessionSelector } = require('../core/session-selector')
  const selector = new SessionSelector({ db: store })
  const provider = process.env.ZEROKEY_PROVIDER || process.argv[2]
  const user = process.env.ZEROKEY_USER || process.argv[3]
  const session = process.env.ZEROKEY_SESSION || process.argv[4]
  const headless = Boolean(provider && user && session)

  let preSelected = null
  if (headless) {
    preSelected = await selector.select(false, provider, user, session)
    if (!preSelected) {
      log.error(
        'Session "' +
          session +
          '" for user "' +
          user +
          '" under provider "' +
          provider +
          '" not found.',
      )
      log.error('Check the SQLite users/sessions tables, or run without args for the wizard.')
      release()
      try {
        store.close()
      } catch {}
      process.exit(2)
    }
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    preSelected = await selector.select(true)
    if (!preSelected) {
      log.info('No session selected. Exiting.')
      release()
      try {
        store.close()
      } catch {}
      release()
      try {
        store.close()
      } catch {}
      process.exit(0)
    }
  } else {
    log.error('No session selected and no TTY available for the wizard.')
    log.error('Set ZEROKEY_PROVIDER, ZEROKEY_USER and ZEROKEY_SESSION, or run at a terminal.')
    release()
    try {
      store.close()
    } catch {}
    process.exit(2)
  }

  log.info(
    'Session: ' +
      preSelected.user +
      ' / ' +
      preSelected.provider +
      ' / ' +
      preSelected.sessionName +
      ' (' +
      preSelected.sessionTags +
      ')',
  )

  const server = require('../server')
  await server.start({ db: store, preSelected })

  const shutdown = (signal) => {
    try {
      selector.flush()
    } catch {}
    log.info('Signal ' + signal + ' received, shutting down.')
    server.stop().then(
      () => {
        release()
        try {
          store.close()
        } catch {}
        log.close()
        process.exit(0)
      },
      (err) => {
        log.error('Shutdown failed: ' + err.message)
        release()
        process.exit(1)
      },
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(signal, () => shutdown(signal))
    } catch {}
  }

  process.on('exit', release)
  return null
}

if (require.main === module) {
  main().then(
    (code) => {
      if (code !== null) process.exit(code)
    },
    (err) => {
      log.error('Start failed: ' + (err && err.stack ? err.stack : String(err)))
      release()
      process.exit(1)
    },
  )
}

module.exports = { main }
