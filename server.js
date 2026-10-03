const log = require('./utils/log')
const startup = require('./utils/startup')
const db = require('./core/state/db')

async function run() {
  const pre = await startup.preflight()
  if (!pre.claimed) return 0

  const store = db.open()

  const { SessionSelector } = require('./core/session-selector')
  const selector = new SessionSelector({ db: store })
  const provider = process.env.ZEROKEY_PROVIDER || process.argv[2]
  const user = process.env.ZEROKEY_USER || process.argv[3]
  const session = process.env.ZEROKEY_SESSION || process.argv[4]
  const headless = Boolean(provider && user && session)

  const cleanup = () => {
    startup.release()
    try {
      store.close()
    } catch {}
  }

  let preSelected = null
  if (headless) {
    preSelected = await selector.select(false, provider, user, session)
    if (!preSelected) {
      log.error(
        'Session "',
        session,
        '" for user "',
        user,
        '" under provider "',
        provider,
        '" not found.',
      )
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
    'Session: ',
    preSelected.user,
    ' / ',
    preSelected.provider,
    ' / ',
    preSelected.sessionName,
    ' (',
    preSelected.sessionTags,
    ')',
  )

  const app = require('./app')
  await app.start({ db: store, preSelected })

  const shutdown = (signal) => {
    try {
      selector.flush()
    } catch {}
    log.info('Signal ' + signal + ' received, shutting down.')
    app.stop().then(
      () => {
        cleanup()
        process.exit(0)
      },
      (err) => {
        log.error('Shutdown failed: ' + (err && err.message ? err.message : err))
        startup.release()
        process.exit(1)
      },
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(signal, () => shutdown(signal))
    } catch {}
  }

  process.on('exit', () => startup.release())
  return null
}

run().then(
  (code) => {
    if (code !== null) process.exit(code)
  },
  (err) => {
    log.error('Start failed: ' + (err && err.stack ? err.stack : String(err)))
    startup.release()
    process.exit(1)
  },
)
