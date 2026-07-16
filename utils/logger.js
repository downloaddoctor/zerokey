const codes = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[38;5;51m',
  yellow: '\x1b[33m',
  blue: '\x1b[38;5;33m',
  red: '\x1b[31m',
}

function make(tag) {
  const code = codes[tag]
  return function (text) {
    return code + text + codes.reset
  }
}

const text = {
  dim: make('dim'),
  bold: make('bold'),
  green: make('green'),
  cyan: make('cyan'),
  yellow: make('yellow'),
  blue: make('blue'),
  red: make('red'),
}

const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _error = console.error.bind(console)
const _debug = console.debug.bind(console)

console.warn = function (...args) {
  _warn(...args.map((a) => (typeof a === 'string' ? text.yellow(a) : a)))
}

console.error = function (...args) {
  _error(...args.map((a) => (typeof a === 'string' ? text.red(a) : a)))
}

console.debug = function (...args) {
  _debug(...args.map((a) => (typeof a === 'string' ? text.dim(a) : a)))
}

console.debug.mix = function (...args) {
  _debug(...args.map((a) => {
    if (typeof a !== 'string') return a
    return codes.dim + a.replace(/\x1b\[0m/g, '\x1b[0m' + codes.dim) + codes.reset
  }))
}

console.success = function (...args) {
  _log(...args.map((a) => (typeof a === 'string' ? text.green(a) : a)))
}

console.info = function (...args) {
  _log(...args.map((a) => (typeof a === 'string' ? text.blue(a) : a)))
}

module.exports = { text }
