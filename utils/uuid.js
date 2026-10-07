'use strict'

const crypto = require('crypto')

/** UUID v4. crypto.randomUUID is built into every supported Node (>=22). */
function uuid() {
  return crypto.randomUUID()
}

module.exports = { uuid }
