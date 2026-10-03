'use strict'
const log = require('./utils/log')
const diagnostics = require('./utils/diagnostics')

const input = { outer: { inner: { access: 'secret-token-value', other: 'visible' } } }
console.log('redact :', log.redact(JSON.stringify(input)))
console.log('sanitize:', JSON.stringify(diagnostics.sanitize(input)))
