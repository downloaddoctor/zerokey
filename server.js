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
const db = require('./core/state/db')
const startup = require('./utils/startup')
const { CONFIG } = require('./config/constants')

require('./utils/log')

async function run() {
  const port = await startup.claimFirstFree({
    start: CONFIG.PORT,
    range: CONFIG.PORT_RANGE,
    exact: CONFIG.EXACT_PORT,
  })
  if (port !== CONFIG.PORT) {
    console.warn(`[PORT] ${CONFIG.PORT} busy, using ${port}.`)
  }

  await startup.postClaim(port)

  const store = db.open()

  const { SessionSelector } = require('./core/session-selector')
  const selector = new SessionSelector(store)
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
      console.error(
        `Session "${session}" for user "${user}" under provider "${provider}" not found.`,
      )
      console.error('Check the SQLite users/sessions tables, or run without args for the wizard.')
      cleanup()
      process.exit(2)
    }
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    preSelected = await selector.select(true)
    if (!preSelected) {
      console.info('No session selected. Exiting.')
      cleanup()
      process.exit(0)
    }
  } else {
    console.error('No session selected and no TTY available for the wizard.')
    console.error('Set ZEROKEY_PROVIDER, ZEROKEY_USER and ZEROKEY_SESSION, or run at a terminal.')
    cleanup()
    process.exit(2)
  }

  const _tags = [
    preSelected.user,
    preSelected.provider,
    preSelected.sessionName,
    preSelected.session.model,
  ].join(' · ')
  console.info(`\n[SERVER] ${_tags}\n         ${preSelected.sessionTags}`)

  const app = require('./app')
  await app.start({ db: store, preSelected, port })

  const shutdown = (signal) => {
    try {
      selector.flush()
    } catch {}
    console.info(`Signal ${signal} received, shutting down.`)
    app.stop().then(
      () => {
        cleanup()
        process.exit(0)
      },
      (err) => {
        console.error(`Shutdown failed: ${err && err.message ? err.message : err}`)
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
    console.error(`Start failed: ${err && err.stack ? err.stack : String(err)}`)
    process.exit(1)
  },
)
