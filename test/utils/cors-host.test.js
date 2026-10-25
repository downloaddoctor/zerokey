'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { app } = require('../../app')

function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function withServer(fn) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(server.address().port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('cors: non-loopback Host is rejected with 403', async () => {
  await withServer(async (port) => {
    const res = await request(port, { headers: { host: 'evil.example.com' } })
    assert.strictEqual(res.status, 403)
  })
})

test('cors: loopback Host names are accepted', async () => {
  await withServer(async (port) => {
    for (const host of ['localhost:' + port, '127.0.0.1:' + port, '[::1]:' + port]) {
      const res = await request(port, { method: 'OPTIONS', headers: { host } })
      assert.strictEqual(res.status, 204, host)
    }
  })
})

test('cors: OPTIONS preflight answers 204 with allow headers', async () => {
  await withServer(async (port) => {
    const res = await request(port, {
      method: 'OPTIONS',
      headers: {
        host: 'localhost:' + port,
        origin: 'http://localhost:3000',
        'access-control-request-headers': 'x-custom',
      },
    })
    assert.strictEqual(res.status, 204)
    assert.match(res.headers['access-control-allow-methods'], /POST/)
    assert.strictEqual(res.headers['access-control-allow-headers'], 'x-custom')
    assert.ok(res.headers['access-control-allow-origin'])
  })
})
