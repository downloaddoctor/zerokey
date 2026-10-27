'use strict'

function createUser(db, provider, username, fields = {}) {
  return db.table('users').add({ ...fields, provider, username })
}

function createSession(db, userId, fields = {}) {
  return db.table('sessions').add({ ...fields, userId })
}

module.exports = { createUser, createSession }
