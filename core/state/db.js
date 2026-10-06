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
const SCHEMA_VERSION = 3

// Columns added after the initial schema. CREATE TABLE IF NOT EXISTS will not
// add them to an existing database, so each is applied with an idempotent
// ALTER TABLE ADD COLUMN. [table, column, type].
const ADDED_COLUMNS = [
  ['sessions', 'last_token_usage', 'INTEGER'],
  ['sessions', 'usage_totals_json', 'TEXT'],
]

function open(options = {}) {
  const file = options.file || CONFIG.DB_FILE
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  assertSupportedSchema(db)
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  applyAddedColumns(db)
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

function applyAddedColumns(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const exists = db
      .prepare('SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?')
      .get(table, column)
    if (exists) continue
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type)
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
  ADDED_COLUMNS,
  open,
  assertSupportedSchema,
  applyAddedColumns,
  setMeta,
  getMeta,
}
