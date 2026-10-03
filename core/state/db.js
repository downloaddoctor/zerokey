'use strict'

/**
 * SQLite state access.
 *
 * Uses the built-in node:sqlite module (Node 22+). Synchronous on purpose:
 * the writes here are tiny lifecycle rows, and an async state layer in a
 * single-slot queue would be able to overtake itself.
 *
 * Fail-closed contract: a database whose schema_version is newer than the
 * code refuses to open. Silent downgrades are how data loss happens.
 *
 * On open, if migrateUsers is not explicitly false, the one-shot importer
 * in core/state/migrate-users.js moves any legacy temp/users.json into the
 * users and sessions tables.
 */

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { CONFIG } = require('../../config/constants')

const SCHEMA_FILE = path.join(__dirname, 'schema.sql')
const SCHEMA_VERSION = 2

function open(options = {}) {
  const file = options.file || CONFIG.DB_FILE
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  assertSupportedSchema(db)
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  setMeta(db, 'schema_version', SCHEMA_VERSION)

  if (options.migrateUsers !== false) {
    const users = require('./users')
    const sessions = require('./sessions')
    const { migrate } = require('./migrate-users')
    try {
      const result = migrate(db, users, sessions)
      if (!result.skipped) {
        console.info(
          'users.json migrated: ' +
            result.usersImported +
            ' user(s), ' +
            result.sessionsImported +
            ' session(s), skipped ' +
            result.skippedExisting +
            ' existing row(s).',
        )
      }
    } catch (error) {
      console.error('users.json migration failed: ' + (error.message || error))
    }
  }

  return db
}

function assertSupportedSchema(db) {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (!table) return

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  if (!row || row.value === null || String(row.value).trim() === '') return

  const text = String(row.value).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error('Invalid SQLite schema_version: ' + text)
  }
  const version = Number(text)
  if (!Number.isSafeInteger(version)) {
    throw new Error('Invalid SQLite schema_version: ' + text)
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      'SQLite schema_version ' +
        version +
        ' is newer than the supported version ' +
        SCHEMA_VERSION +
        '. Refusing to open.',
    )
  }
}

function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value))
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_FILE,
  open,
  assertSupportedSchema,
  setMeta,
  getMeta,
}
