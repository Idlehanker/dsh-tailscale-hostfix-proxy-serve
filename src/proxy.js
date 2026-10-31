/**
 * dsh-tailscale-hostfix-proxy-serve — make a loopback-only back end usable behind a TLS terminator.
 *
 * ## The bug this exists for
 *
 * A whole family of local servers defends against DNS rebinding by checking the
 * request's `Host` header. The check is usually written as one of:
 *
 *   Host hostname ∈ { "localhost", "127.0.0.1", "[::1]" }      // allow-list
 *   Host hostname === socket.localAddress                       // address compare
 *
 * Both are correct for a DIRECT connection and both are unsatisfiable behind a
 * reverse proxy, where the browser must send the public name
 * (`Host: box.example.com`) while the socket lands on 127.0.0.1. No string
 * comparison can make those equal, so the server answers 403 to every request
 * and its UI silently loses data.
 *
 * The right fix belongs upstream (compare Origin to Host, or accept an explicit
 * allow-list). This proxy is the deployment-level workaround: it rewrites the two
 * headers the guards read, so an unmodified back end sees a loopback request.
 *
 * ## Scope
 *
 * It rewrites `Host` and (when present) `Origin`, and forwards everything else
 * byte for byte: method, path, query, body, cookies, status, response headers and
 * the response stream. WebSocket upgrades are proxied, because a UI that loads
 * but cannot open its socket looks like a broken app rather than a broken proxy.
 *
 * @module dsh-tailscale-hostfix-proxy-serve
 */

import http from 'node:http'

/**
 * Hop-by-hop headers, which must not be forwarded (RFC 9110 §7.6.1).
 *
 * `transfer-encoding` is deliberately NOT in this list for responses: the
 * response path strips it explicitly, because Node re-applies its own framing and
 * a forwarded value produces a duplicate header some clients reject.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  // 'upgrade' is deliberately ABSENT: serializeHead relays it on a 101, and the
  // upgrade path builds its own header bag rather than going through this set.
])

/**
 * Remove hop-by-hop headers from an outgoing header bag.
 * @param headers - source headers.
 * @returns a copy without hop-by-hop entries.
 */
export function stripHopByHop(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

/**
 * Build the header rewrite applied to every proxied request.
 *
 * Two things change and nothing else:
 *
 * - `host` becomes the back end's own authority. It is built from the TARGET
 *   port, not the front-door port: the guard compares Host against what it
 *   believes its listener is, and sending the public port would still fail an
 *   allow-list that matches literals.
 * - `origin` becomes the matching loopback origin, but ONLY when an Origin was
 *   already present. Injecting one where the client sent none would turn a
 *   non-browser request into a browser-shaped one, which some servers branch on.
 *
 * `x-forwarded-host` is dropped rather than rewritten: it is the forwarder's
 * note about the original name, and every guard in this family ignores it. Leaving
 * the public name lying around in a header only invites a future reader to trust
 * it.
 *
 * @param incoming - the client's request headers.
 * @param targetAuthority - the back end's `host:port`.
 * @returns headers for the upstream request.
 */
export function rewriteHeaders(incoming, targetAuthority) {
  const headers = { ...incoming }
  headers.host = targetAuthority
  if (headers.origin !== undefined && headers.origin !== '') {
    headers.origin = `http://${targetAuthority}`
  }
  delete headers['x-forwarded-host']
  return headers
}

/**
 * Format an HTTP/1.1 status line plus headers for a raw socket.
 *
 * Used by the upgrade path, which cannot use `res.writeHead` because the socket
 * is not an `http.ServerResponse` after an upgrade.
 *
 * @param statusCode - numeric status.
 * @param statusMessage - reason phrase.
 * @param headers - headers to serialise; arrays are emitted once per element.
 * @returns the wire bytes as a string.
 */
export function serializeHead(statusCode, statusMessage, headers) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`]
  for (const [key, value] of Object.entries(headers)) {
    // `upgrade` and `connection` must be relayed on a 101, so this function is
    // intentionally NOT filtered by HOP_BY_HOP -- the caller decides.
    if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
    else if (value !== undefined) lines.push(`${key}: ${value}`)
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

/**
 * Build the proxy server. Not listening yet — the caller decides where.
 *
 * @param options - listening/forwarding configuration.
 * @param options.targetPort - back end port on 127.0.0.1.
 * @param options.targetHost - back end host; default 127.0.0.1.
 * @param options.rewriteHost - the authority to send upstream; defaults to
 *   `<targetHost>:<targetPort>`, which is what the guards expect.
 * @param options.log - sink for operational lines and errors.
 * @returns an `http.Server` that has not been told to listen.
 */
export function createProxy(options) {
  const targetHost = options.targetHost ?? '127.0.0.1'
  const targetPort = options.targetPort
  const targetAuthority = options.rewriteHost ?? `${targetHost}:${targetPort}`
  const log = options.log ?? (() => {})

  const server = http.createServer((req, res) => {
    const headers = rewriteHeaders(req.headers, targetAuthority)

    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers },
      (up) => {
        const outHeaders = stripHopByHop(up.headers)
        res.writeHead(up.statusCode ?? 502, outHeaders)
        up.pipe(res)
      },
    )

    upstream.on('error', (error) => {
      log(`upstream error ${req.method} ${req.url}: ${error.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      }
      res.end(JSON.stringify({ error: 'proxy-upstream-unreachable', detail: error.message }))
    })

    // Stream the body rather than buffering: uploads and long streaming
    // responses both pass through here.
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket, head) => {
    const headers = rewriteHeaders(req.headers, targetAuthority)

    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    })

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(serializeHead(upRes.statusCode ?? 101, upRes.statusMessage ?? 'Switching Protocols', upRes.headers))
      if (upHead !== undefined && upHead.length > 0) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
    })

    // The back end declined to upgrade. Relay its real answer rather than
    // closing the socket with no explanation.
    upstream.on('response', (upRes) => {
      socket.write(serializeHead(upRes.statusCode ?? 500, upRes.statusMessage ?? 'Error', upRes.headers))
      upRes.pipe(socket)
    })

    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  return server
}

/**
 * Start the proxy on a port.
 *
 * Binds 127.0.0.1 ONLY. That is load-bearing, not a default: the security note in
 * the README rests on the listener being unreachable from the network, so only
 * the already-authenticated front door can drive the rewrite.
 *
 * @param options - everything {@link createProxy} takes, plus `port`.
 * @returns a promise resolving once listening, with the bound address.
 */
export function startProxy(options) {
  const server = createProxy(options)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve({ server, address: server.address() })
    })
  })
}
