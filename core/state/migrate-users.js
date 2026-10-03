'use strict'

/**
 * One-shot migration from temp/users.json into the users + sessions tables.
 *
 * Runs at most once per database (guarded by meta.users_json_migrated).
 * On success, renames temp/users.json to temp/users.json.migrated-<ts>.
 *
 * Never throws on a missing or malformed file: the caller logs the outcome
 * and keeps going.
 */

const fs = require('fs')
const path = require('path')
const { CONFIG } = require('../../config/constants')

const META_KEY = 'users_json_migrated'

function usersFile() {
  return path.join(CONFIG.DATA_DIR, 'users.json')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}

function metaSet(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value))
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function migrate(db, usersModule, sessionsModule) {
  if (metaGet(db, META_KEY)) return { skipped: true, reason: 'already_migrated' }

  const file = usersFile()
  if (!fs.existsSync(file)) {
    metaSet(db, META_KEY, Date.now())
    return { skipped: true, reason: 'no_users_file' }
  }

  const data = readJson(file)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    metaSet(db, META_KEY, Date.now())
    return { skipped: true, reason: 'malformed_users_file' }
  }

  let usersImported = 0
  let sessionsImported = 0
  let skippedExisting = 0

  db.exec('BEGIN')
  try {
    for (const [provider, bucket] of Object.entries(data)) {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue
      for (const [username, record] of Object.entries(bucket)) {
        if (!record || typeof record !== 'object') continue

        const existing = usersModule.get(db, provider, username)
        const user =
          existing ||
          usersModule.create(db, provider, username, {
            parsedFetch: record.parsedFetch || {},
            instructionsHash: record.instructionsHash ?? null,
            instructionsAppliedAt: toMs(record.instructionsAppliedAt),
            waitUntil: record.waitUntil ?? null,
            waitReason: record.waitReason ?? null,
          })
        if (existing) skippedExisting += 1
        else usersImported += 1

        const list = Array.isArray(record.sessions) ? record.sessions : []
        for (const entry of list) {
          if (!entry || typeof entry !== 'object') continue
          const name = typeof entry.name === 'string' ? entry.name : null
          if (!name) continue
          if (sessionsModule.get(db, user.id, name)) {
            skippedExisting += 1
            continue
          }
          sessionsModule.create(db, user.id, {
            name,
            id: entry.chatSessionId || null,
            parentId: entry.parentMessageId || null,
            generation: 0,
            toolCalling: entry.toolCalling ?? true,
            vision: entry.vision ?? false,
            model: entry.model ?? null,
            todos: entry.todos ?? null,
            turnCount: entry.turnCount ?? 0,
            dynamicToolsHash: entry.dynamicToolsHash ?? null,
            mcpInjected: entry.mcpInjected ?? null,
            state: entry.chatSessionId ? 'idle' : 'unbound',
            metadata: {},
            lastUsed: toMs(entry.lastUsed) ?? Date.now(),
            createdAt: toMs(entry.createdAt) ?? Date.now(),
          })
          sessionsImported += 1
        }
      }
    }

    metaSet(db, META_KEY, Date.now())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    return { skipped: true, reason: 'error:' + error.message }
  }

  try {
    fs.renameSync(file, file + '.migrated-' + Date.now())
  } catch (error) {
    console.error('Could not rename users.json after migration: ' + (error.message || error))
  }

  return { usersImported, sessionsImported, skippedExisting, skipped: false }
}

module.exports = { META_KEY, migrate, usersFile }
