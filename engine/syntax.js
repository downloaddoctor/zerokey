const SYNTAX = {
  xNAME: 'mhi',
  NAME: 'MHI',
  OPEN: String.fromCharCode(0x27e6),
  CLOSE: String.fromCharCode(0x27e7),
  SEP: String.fromCharCode(0x00a6),
  ESC: '\\',
}

// Find the index of the first unescaped close token in a raw block body,
// or -1. A close preceded by an odd number of backslashes is a literal.
function findClose(raw) {
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === SYNTAX.ESC) {
      escaped = true
      continue
    }
    if (c === SYNTAX.CLOSE) return i
  }
  return -1
}

// Split a raw MHI payload on the separator, honouring the two escape
// sequences (backslash + separator, backslash + close). Backslashes used
// for escapes are stripped; any other backslash is preserved verbatim.
function splitPayload(raw) {
  const out = []
  let buf = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === SYNTAX.ESC) {
      const n = raw[i + 1]
      if (n === SYNTAX.SEP || n === SYNTAX.CLOSE || n === SYNTAX.ESC) {
        buf += n
        i++
        continue
      }
      buf += c
      continue
    }
    if (c === SYNTAX.SEP) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  out.push(buf)
  return out
}

module.exports = { ...SYNTAX, findClose, splitPayload }
