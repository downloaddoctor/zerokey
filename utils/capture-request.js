const fs = require('fs')
const path = require('path')

const CAPTURES_DIR = path.join(require('./bundle').ROOT, 'temp', 'captures')

function ensureDir() {
  if (!fs.existsSync(CAPTURES_DIR)) {
    fs.mkdirSync(CAPTURES_DIR, { recursive: true })
  }
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

/**
 * Writes req.body to temp/captures/req_<timestamp>.json for later inspection.
 *
 * @param {import('express').Request} req
 * @param {string} [prefix] - filename prefix, defaults to 'req'
 * @returns {string} the written filename
 */
function captureRequest(req, prefix = 'req') {
  ensureDir()
  const name = `${prefix}_${timestamp()}.json`
  fs.writeFileSync(path.join(CAPTURES_DIR, name), JSON.stringify(req.body, null, 2))
  return name
}

module.exports = { captureRequest, CAPTURES_DIR }
