'use strict'

/**
 * One-time, read-only import of temp/users.json into the sessions table.
 *
 * Contract:
 *   - runs at most once per database (guarded by meta.legacy_import_done)
 *   - never writes to users.json
 *   - never overwrites an existing sessions row
 *   - never throws if users.json is missing, malformed, or has an unexpected
 *     shape — the caller logs the outcome and keeps going
 */

const fs = require('fs')
const path = require('path')
const { CONFIG } = require('../../config/constants')
const sessions = require('./sessions')

const META_KEY = 'legacy_import_done'

function legacyFile() {
  return path.join(CONFIG.DATA_DIR, 'users.json')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function importOnce(db) {
  const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY)
  if (done) return { imported: 0, skipped: true, reason: 'already_imported' }

  const file = legacyFile()
  if (!fs.existsSync(file)) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(META_KEY, String(Date.now()))
    return { imported: 0, skipped: true, reason: 'no_legacy_file' }
  }

  const data = readJson(file)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(META_KEY, String(Date.now()))
    return { imported: 0, skipped: true, reason: 'malformed_legacy_file' }
  }

  let imported = 0
  let skippedExisting = 0

  db.exec('BEGIN')
  try {
    for (const [providerName, users] of Object.entries(data)) {
      const provider = sessions.normalizeProvider(providerName)
      if (!provider || !users || typeof users !== 'object' || Array.isArray(users)) continue

      for (const [username, userRecord] of Object.entries(users)) {
        const list = userRecord && Array.isArray(userRecord.sessions) ? userRecord.sessions : []
        for (const entry of list) {
          const sessionId = sessions.normalizeId(entry && (entry.name || entry.id))
          if (!sessionId) continue

          const existing = sessions.get(db, provider, sessionId)
          if (existing) {
            skippedExisting += 1
            continue
          }

          sessions.save(db, {
            provider,
            id: sessionId,
            upstreamConversationId: entry.chatSessionId || null,
            upstreamParentMessageId: entry.parentMessageId || null,
            state: entry.chatSessionId ? 'idle' : 'unbound',
            metadata: {},
          })
          db.prepare(
            'INSERT OR IGNORE INTO legacy_import ' +
              '(provider, username, session_id, imported_at) VALUES (?, ?, ?, ?)',
          ).run(provider, String(username), sessionId, Date.now())
          imported += 1
        }
      }
    }

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(META_KEY, String(Date.now()))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    return { imported: 0, skipped: true, reason: 'error:' + error.message }
  }

  return { imported, skippedExisting, skipped: false, reason: 'imported' }
}

module.exports = { META_KEY, importOnce, legacyFile }
