const net = require('net')

function checkPort(p) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(400)
    sock
      .once('connect', () => resolve((sock.destroy(), false)))
      .once('error', () => resolve((sock.destroy(), true)))
      .once('timeout', () => resolve((sock.destroy(), true)))
      .connect(p, '127.0.0.1')
  })
}

async function findPort(start, range = 100) {
  for (let port = start; port <= start + range; port++) {
    if (await checkPort(port)) {
      if (port !== start) console.warn(`\n⚠ Port ${start} is already in use. Using port ${port} instead.`)
      return port
    }
  }
  console.error('No available ports found in range.')
  process.exit(1)
}

module.exports = { findPort }
