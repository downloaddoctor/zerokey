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
 * The whole open sequence (PRAGMAs, meta table, store schemas, ladder) lives in
 * sqlite-pro. This file names the stores, the baseline and every upgrade
 * callback on one chain, Dexie-style. Version 4 is the v3 -> v4 reshape: it is
 * flagged beforeDefine() because it rebuilds the users table the schema would
 * otherwise create first.
 */

const { CONFIG } = require('../../config/constants')

const { openDatabase } = require('sqlite-pro')
const { upgradeV3ToV4 } = require('./migrate-v3-v4')
const users = require('./users')
const sessions = require('./sessions')

// Baseline version of the declared schemas. Additive changes (new column, table,
// index) need no bump: store.define applies them on every open.
const BASE_SCHEMA_VERSION = 4

const migrator = openDatabase({
  file: CONFIG.DB_FILE,
  stores: [users, sessions],
  baseline: BASE_SCHEMA_VERSION,
})
  .version(4, 'v3->v4: capture_* columns + user_headers')
  .beforeDefine()
  .upgrade((db, ctx) => {
    if (upgradeV3ToV4(db, ctx)) {
      console.log(
        'SQLite users table upgraded from schema_version 3 to 4 (capture_* + user_headers)',
      )
    }
  })
// .version(5, 'add something').upgrade((db) => db.exec('ALTER TABLE users ...'))

const { SCHEMA_VERSION, getVersion, getMeta, setMeta } = migrator
const assertSupportedSchema = migrator.assertSupported
const runMigrations = migrator.run
// Ladder steps declared on the chain above, kept exported for callers that pass them on.
const MIGRATIONS = migrator.steps

function open(options = {}) {
  return migrator.open(options.file || CONFIG.DB_FILE)
}

module.exports = {
  SCHEMA_VERSION,
  BASE_SCHEMA_VERSION,
  MIGRATIONS,
  getVersion,
  runMigrations,
  open,
  assertSupportedSchema,
  setMeta,
  getMeta,
}
