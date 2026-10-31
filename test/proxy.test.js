import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  createProxy,
  rewriteHeaders,
  serializeHead,
  startProxy,
  stripHopByHop,
} from '../src/proxy.js'

/**
 * A stand-in for the class of server this tool exists for.
 *
 * It refuses any request whose Host hostname is not loopback, which is exactly
 * what `dsh-codex-pet` and others do. Using the real failure shape rather than a
 * generic echo server is what makes these tests meaningful: a proxy that passes
 * an echo test can still fail the only case that matters.
 */
function loopbackGuardedServer() {
  return http.createServer((req, res) => {
    const hostname = new URL(`http://${req.headers.host ?? ''}`).hostname
    const allowed = ['localhost', '127.0.0.1', '[::1]']
    if (!allowed.includes(hostname)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'untrusted host', seen: hostname }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, host: req.headers.host, origin: req.headers.origin ?? null, path: req.url }))
  })
}

/** Start a server on an ephemeral port. */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** One GET with an explicit Host header. */
function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the guarded server refuses a public Host directly', async () => {
  const back = loopbackGuardedServer()
  const port = await listen(back)
  try {
    const res = await get(port, '/', { host: 'box.example.com' })
    assert.equal(res.status, 403, 'the fixture must reproduce the real failure')
  } finally {
    back.close()
  }
})

test('the proxy makes the guarded server accept a public Host', async () => {
  const back = loopbackGuardedServer()
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    // Before: refused.
    assert.equal((await get(backPort, '/', { host: 'box.example.com' })).status, 403)

    // After: accepted, and the back end saw a loopback authority.
    const res = await get(address.port, '/', { host: 'box.example.com' })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.match(body.host, /^127\.0\.0\.1:\d+$/, 'upstream Host must be the loopback authority')
  } finally {
    server.close()
    back.close()
  }
})

test('an Origin already present is rewritten to match Host', async () => {
  const back = loopbackGuardedServer()
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    const res = await get(address.port, '/', { host: 'box.example.com', origin: 'https://box.example.com' })
    const body = JSON.parse(res.body)
    // Same-origin comparison (what well-written guards do) must hold upstream.
    assert.equal(new URL(body.origin).host, body.host)
  } finally {
    server.close()
    back.close()
  }
})

test('an absent Origin stays absent (no invention)', async () => {
  const back = loopbackGuardedServer()
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    const res = await get(address.port, '/', { host: 'box.example.com' })
    assert.equal(JSON.parse(res.body).origin, null, 'a non-browser request must not become browser-shaped')
  } finally {
    server.close()
    back.close()
  }
})

test('the request path and query survive', async () => {
  const back = loopbackGuardedServer()
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    const res = await get(address.port, '/api/state?region=cn&x=1', { host: 'box.example.com' })
    assert.equal(JSON.parse(res.body).path, '/api/state?region=cn&x=1')
  } finally {
    server.close()
    back.close()
  }
})

test('a request body is forwarded', async () => {
  const back = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ received: body }))
    })
  })
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: address.port, path: '/', method: 'POST', headers: { host: 'box.example.com' } },
        (res) => {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve(JSON.parse(body)))
        },
      )
      req.on('error', reject)
      req.end('hello=world')
    })
    assert.equal(result.received, 'hello=world')
  } finally {
    server.close()
    back.close()
  }
})

test('a WebSocket upgrade is relayed end to end', async () => {
  // A minimal upgrade echo: accepts, then writes one frame-ish line back.
  const back = http.createServer()
  back.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write('HELLO')
    socket.end()
  })
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/mux',
        headers: { host: 'box.example.com', connection: 'Upgrade', upgrade: 'websocket' },
      })
      req.on('upgrade', (res, socket, upgradeHead) => {
        // Node hands the bytes that arrived together with the 101 as the third
        // argument, NOT through the socket stream. Reading only the stream makes
        // this test pass vacuously on a proxy that drops that head.
        let data = upgradeHead === undefined ? '' : String(upgradeHead)
        socket.on('data', (chunk) => { data += chunk })
        socket.on('end', () => resolve({ status: res.statusCode, data }))
        socket.on('close', () => resolve({ status: res.statusCode, data }))
        socket.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(received.status, 101, 'the upgrade must be relayed, not downgraded')
    assert.match(received.data, /HELLO/)
  } finally {
    server.close()
    back.close()
  }
})

test('an unreachable back end yields 502, not a hang', async () => {
  // Bind then immediately free a port so nothing is listening there.
  const probe = http.createServer()
  const deadPort = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  }))
  const { server, address } = await startProxy({ port: 0, targetPort: deadPort })
  try {
    const res = await get(address.port, '/', { host: 'box.example.com' })
    assert.equal(res.status, 502)
    assert.match(res.body, /proxy-upstream-unreachable/)
  } finally {
    server.close()
  }
})

test('rewriteHeaders changes only host and origin', () => {
  const out = rewriteHeaders(
    { host: 'box.example.com', origin: 'https://box.example.com', cookie: 'a=b', 'x-forwarded-host': 'box.example.com' },
    '127.0.0.1:18680',
  )
  assert.equal(out.host, '127.0.0.1:18680')
  assert.equal(out.origin, 'http://127.0.0.1:18680')
  assert.equal(out.cookie, 'a=b', 'credentials must pass through untouched')
  assert.equal(out['x-forwarded-host'], undefined, 'the public name must not be left lying around')
})

test('stripHopByHop removes framing headers', () => {
  const out = stripHopByHop({ connection: 'keep-alive', 'transfer-encoding': 'chunked', 'content-type': 'text/plain' })
  assert.equal(out.connection, undefined)
  assert.equal(out['transfer-encoding'], undefined, 'Node re-applies framing; forwarding it duplicates the header')
  assert.equal(out['content-type'], 'text/plain')
})

test('serializeHead emits one line per array element', () => {
  const wire = serializeHead(101, 'Switching Protocols', { upgrade: 'websocket', 'set-cookie': ['a=1', 'b=2'] })
  assert.match(wire, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.match(wire, /set-cookie: a=1\r\nset-cookie: b=2\r\n/)
  assert.match(wire, /\r\n\r\n$/)
})

test('startProxy binds loopback only', async () => {
  const back = loopbackGuardedServer()
  const backPort = await listen(back)
  const { server, address } = await startProxy({ port: 0, targetPort: backPort })
  try {
    assert.equal(address.address, '127.0.0.1', 'the security note depends on this being loopback-only')
  } finally {
    server.close()
    back.close()
  }
})
