'use strict'

/**
 * Generic row store: debounced write-through persistence plus a recursive
 * Proxy, configured per table. users.js and sessions.js only supply config
 * (table, columns, key, conflict target) and keep their own domain logic.
 *
 * cfg = {
 *   table,        // SQL table name
 *   columnMap,    // camelCase field -> snake_case column
 *   blobKeys,     // Set of fields stored as JSON in their column
 *   conflict,     // array of columns forming the upsert target
 *   keyOf(obj),   // stable pending-map key for a row object
 *   flushMs,      // debounce window
 *   label,        // log label, e.g. 'users'
 * }
 */

function parseBlob(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (caughtErr) {
    console.error('JSON.parse() failed:', caughtErr)
    return fallback
  }
}

// Only arrays and plain objects are proxied; Date, Buffer, Map and class
// instances pass through untouched so their internal slots keep working.
function isPlain(value) {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return true
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function createStore(cfg) {
  const { columnMap, blobKeys, conflict, keyOf, flushMs, label } = cfg
  const pending = new Map()

  function columnProjection(obj) {
    const columns = {}
    const state = {}
    for (const [key, value] of Object.entries(obj)) {
      const column = columnMap[key]
      if (!column) {
        state[key] = value
        continue
      }
      if (blobKeys.has(key)) {
        columns[column] = value === null || value === undefined ? null : JSON.stringify(value)
      } else if (typeof value === 'boolean') {
        columns[column] = value ? 1 : 0
      } else if (value === undefined) {
        columns[column] = null
      } else {
        columns[column] = value
      }
    }
    return {
      columns,
      state: Object.keys(state).length === 0 ? null : JSON.stringify(state),
    }
  }

  function flush(db, obj) {
    const { columns, state } = columnProjection(obj)
    columns.state_json = state
    columns.updated_at = Date.now()
    // Bypass the proxy trap: updatedAt is a flush artifact, not a caller edit.
    const raw = obj && obj.__raw ? obj.__raw : obj
    raw.updatedAt = columns.updated_at

    const names = Object.keys(columns)
    const placeholders = names.map(() => '?').join(', ')
    const updates = names
      .filter((n) => !conflict.includes(n))
      .map((n) => n + ' = excluded.' + n)
      .join(', ')
    db.prepare(
      'INSERT INTO ' +
        cfg.table +
        ' (' +
        names.join(', ') +
        ') VALUES (' +
        placeholders +
        ') ON CONFLICT(' +
        conflict.join(', ') +
        ') DO UPDATE SET ' +
        updates,
    ).run(...names.map((n) => columns[n]))
  }

  function schedule(db, obj) {
    const key = keyOf(obj)
    if (pending.has(key)) return
    const timer = setTimeout(() => {
      pending.delete(key)
      try {
        if (!db.isOpen) return
        flush(db, obj)
      } catch (error) {
        console.error(label + ' flush failed: ', error)
      }
    }, flushMs)
    if (typeof timer.unref === 'function') timer.unref()
    // Remember what to flush so flushAll() can drain at shutdown.
    timer.entry = { db, obj }
    pending.set(key, timer)
  }

  // Recursively wrap plain objects/arrays so nested writes hit a set trap and
  // schedule a flush on the root row. The proxy cache is scoped to one wrap()
  // call: two rows sharing a nested object must not share a proxy, or a write
  // would schedule the wrong root.
  function deepWrap(db, root, value, cache) {
    if (!isPlain(value)) return value
    const cached = cache.get(value)
    if (cached) return cached
    const proxy = new Proxy(value, {
      get(target, key) {
        if (key === '__raw') return target
        return deepWrap(db, root, target[key], cache)
      },
      set(target, key, next) {
        target[key] = next
        // updatedAt is written by flush() itself; scheduling on it would
        // re-arm the timer and suppress the next real write.
        if (key !== 'updatedAt' && key !== 'createdAt') schedule(db, root)
        return true
      },
      deleteProperty(target, key) {
        delete target[key]
        schedule(db, root)
        return true
      },
    })
    cache.set(value, proxy)
    return proxy
  }

  function wrap(db, obj) {
    return deepWrap(db, obj, obj, new WeakMap())
  }

  function cancel(key) {
    if (!pending.has(key)) return
    clearTimeout(pending.get(key))
    pending.delete(key)
  }

  function cancelWhere(predicate) {
    for (const key of [...pending.keys()]) if (predicate(key)) cancel(key)
  }

  function flushNow(db, obj) {
    cancel(keyOf(obj))
    flush(db, obj)
  }

  // Drain every pending debounced write synchronously (shutdown path).
  function flushAll() {
    for (const [key, timer] of [...pending]) {
      clearTimeout(timer)
      pending.delete(key)
      const entry = timer.entry
      if (!entry || !entry.db.isOpen) continue
      try {
        flush(entry.db, entry.obj)
      } catch (error) {
        console.error(label + ' flushAll failed: ', error)
      }
    }
  }

  return { cancel, cancelWhere, columnProjection, flush, flushAll, flushNow, schedule, wrap }
}

module.exports = { createStore, isPlain, parseBlob }
