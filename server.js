'use strict'

/**
 * ZeroKey entrypoint. Only supported way to run the server.
 *
 *   node server.js                        - wizard (interactive)
 *   ZEROKEY_PROVIDER=... node server.js   - headless with a pinned session
 *
 * Port selection is driven by the lock file. Each instance claims the first
 * port whose temp/db/.start.<port>.lock is absent or orphaned. Multiple
 * instances share temp/db/zerokey.db (users and sessions), each on its own
 * port. ZEROKEY_EXACT_PORT=1 refuses a busy start port instead of moving.
 */

const log = require('./utils/log')
const startup = require('./utils/startup')
const { CONFIG } = require('./config/constants')
const db = require('./core/state/db')

async function run() {
  const port = await startup.claimFirstFree({
    start: CONFIG.PORT,
    range: CONFIG.PORT_RANGE,
    exact: CONFIG.EXACT_PORT,
  })
  if (port !== CONFIG.PORT) {
    log.info(`Port ${CONFIG.PORT} busy, using ${port}.`)
  }

  await startup.postClaim(port)

  const store = db.open()

  const { SessionSelector } = require('./core/session-selector')
  const selector = new SessionSelector({ db: store })
  const provider = process.env.ZEROKEY_PROVIDER || process.argv[2]
  const user = process.env.ZEROKEY_USER || process.argv[3]
  const session = process.env.ZEROKEY_SESSION || process.argv[4]
  const headless = Boolean(provider && user && session)

  const cleanup = () => {
    startup.release(port)
    try {
      store.close()
    } catch {}
  }

  let preSelected = null
  if (headless) {
    preSelected = await selector.select(false, provider, user, session)
    if (!preSelected) {
      log.error(`Session "${session}" for user "${user}" under provider "${provider}" not found.`)
      log.error('Check the SQLite users/sessions tables, or run without args for the wizard.')
      cleanup()
      process.exit(2)
    }
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    preSelected = await selector.select(true)
    if (!preSelected) {
      log.info('No session selected. Exiting.')
      cleanup()
      process.exit(0)
    }
  } else {
    log.error('No session selected and no TTY available for the wizard.')
    log.error('Set ZEROKEY_PROVIDER, ZEROKEY_USER and ZEROKEY_SESSION, or run at a terminal.')
    cleanup()
    process.exit(2)
  }

  log.info(
    `Session: ${preSelected.user} / ${preSelected.provider} / ${preSelected.sessionName} (${preSelected.sessionTags})`,
  )

  const app = require('./app')
  await app.start({ db: store, preSelected, port })

  const shutdown = (signal) => {
    try {
      selector.flush()
    } catch {}
    log.info(`Signal ${signal} received, shutting down.`)
    app.stop().then(
      () => {
        cleanup()
        process.exit(0)
      },
      (err) => {
        log.error(`Shutdown failed: ${err && err.message ? err.message : err}`)
        startup.release(port)
        process.exit(1)
      },
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(signal, () => shutdown(signal))
    } catch {}
  }

  process.on('exit', () => startup.release(port))
  return null
}

run().then(
  (code) => {
    if (code !== null) process.exit(code)
  },
  (err) => {
    log.error(`Start failed: ${err && err.stack ? err.stack : String(err)}`)
    process.exit(1)
  },
)
