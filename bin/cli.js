#!/usr/bin/env node
/**
 * Command line for hostfix-proxy.
 *
 * Three verbs, chosen so that the two questions a user actually has are each one
 * command:
 *
 *   start   — run the proxy (what launchd/systemd executes)
 *   check   — "is my back end Host-guarded, and does the proxy fix it?"
 *   explain — what the rewrite does, in plain terms
 *
 * `check` exists because the first instinct on a 403 is to blame the credential
 * or the service, and this narrows it down in one step instead of five.
 *
 * @module hostfix-proxy/bin
 */

import http from 'node:http'
import { startProxy } from '../src/proxy.js'

const DEFAULT_LISTEN_PORT = 18682
const DEFAULT_TARGET_PORT = 18680

const HELP = `hostfix-proxy — serve a loopback-only back end behind a TLS proxy

USAGE
  hostfix-proxy start   [--listen <port>] [--target <port>] [--host <host>]
  hostfix-proxy check   [--target <port>] [--listen <port>] [--path <path>]
  hostfix-proxy explain

OPTIONS
  --listen <port>   port to accept on (default ${DEFAULT_LISTEN_PORT}), bound to 127.0.0.1 only
  --target <port>   port of the back end (default ${DEFAULT_TARGET_PORT})
  --host <host>     back-end host (default 127.0.0.1)
  --path <path>     path probed by \`check\` (default /)
  -h, --help        this text

WHY
  Some servers answer 403 to any request whose Host header is not loopback. Behind
  \`tailscale serve\`, Caddy, nginx or a tunnel the browser must send the public
  name, so those servers refuse every request. This proxy rewrites Host and Origin
  to the loopback authority before forwarding.

EXIT CODES
  check: 0 healthy through the proxy, 1 back end unreachable,
         2 back end refuses non-loopback Host and the proxy is not running,
         3 proxy running but its response differs from the back end's
`

/**
 * Parse `--flag value` pairs.
 * @param argv - arguments after the verb.
 * @returns a plain options object.
 */
function parse(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i += 1 }
  }
  return out
}

/**
 * One HTTP GET with a chosen Host header.
 *
 * `Host` is passed explicitly because that is the whole point of the exercise: we
 * need to send a NON-loopback Host to see whether the back end refuses it.
 *
 * @param port - port to connect to on 127.0.0.1.
 * @param path - request path.
 * @param hostHeader - the Host header to send.
 * @returns status code, or undefined if the socket failed.
 */
function probe(port, path, hostHeader) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader }, timeout: 4000 },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) },
    )
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.on('error', () => resolve(undefined))
    req.end()
  })
}

const [verb, ...rest] = process.argv.slice(2)
const flags = parse(rest)

if (verb === 'explain') {
  console.log(`hostfix-proxy rewrites exactly two request headers before forwarding:

  host    -> <target host>:<target port>
  origin  -> http://<target host>:<target port>   (only when one was sent)

It never injects an Origin the client did not send, never strips cookies, and
passes the request and response bodies through as streams.

The listener binds 127.0.0.1 only. Nothing on the network can reach it directly;
the only way in is the TLS terminator that already authenticated the client.
`)
  process.exit(0)
}

if (verb === 'check') {
  const targetPort = Number(flags.target ?? DEFAULT_TARGET_PORT)
  const listenPort = Number(flags.listen ?? DEFAULT_LISTEN_PORT)
  const path = flags.path ?? '/'
  const publicName = 'example.invalid'

  const direct = await probe(targetPort, path, `${publicName}`)
  const viaProxy = await probe(listenPort, path, `${publicName}`)

  console.log(`target        : 127.0.0.1:${targetPort}${path}`)
  console.log(`proxy         : 127.0.0.1:${listenPort}`)
  console.log(`Host sent     : ${publicName}  (a deliberately non-loopback name)`)
  console.log('')
  console.log(`direct        : ${direct ?? 'unreachable'}`)
  console.log(`via proxy     : ${viaProxy ?? 'not running'}`)

  if (direct === undefined) {
    console.log('')
    console.log('The back end is not answering on that port.')
    if (viaProxy !== undefined) {
      // The proxy in front may be serving a DIFFERENT app; say so rather than
      // letting its status read as this target's answer.
      console.log(`The proxy answered ${viaProxy}, but it forwards to its own configured`)
      console.log(' target, not to the one named above — that number is not this port.')
    }
    process.exit(1)
  }
  if (direct === 403 && viaProxy === undefined) {
    console.log('\nThis is the bug this tool fixes, and the proxy is not running yet:')
    console.log(`  hostfix-proxy start --target ${targetPort}`)
    process.exit(2)
  }
  if (direct === 403 && viaProxy !== undefined && viaProxy !== 403) {
    console.log('\nThe proxy is running and the back end accepts its rewritten Host.')
    console.log('Point your TLS terminator at the proxy and you are done.')
    process.exit(0)
  }
  if (direct === 403 && viaProxy === 403) {
    console.log('\nBoth paths are refused. The guard is not Host-based, or the proxy')
    console.log('is not actually in front of this request. Check the terminator mapping.')
    process.exit(3)
  }
  if (direct !== 403) {
    console.log(`\nThe back end accepted a non-loopback Host (status ${direct}), so this`)
    console.log('tool is not needed for it.')
    process.exit(0)
  }
  process.exit(0)
}

if (verb === 'start' || verb === undefined) {
  const listenPort = Number(flags.listen ?? DEFAULT_LISTEN_PORT)
  const targetPort = Number(flags.target ?? DEFAULT_TARGET_PORT)
  const targetHost = flags.host ?? '127.0.0.1'

  try {
    const { address } = await startProxy({
      port: listenPort,
      targetPort,
      targetHost,
      log: (message) => console.error(`[hostfix] ${message}`),
    })
    console.log(
      `[hostfix] listening on http://127.0.0.1:${address.port} -> ${targetHost}:${targetPort}`
      + ` (Host rewritten to ${targetHost}:${targetPort})`,
    )
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`[hostfix] port ${listenPort} is already in use — another instance is running`)
      process.exit(0)
    }
    console.error(`[hostfix] failed to start: ${error.message}`)
    process.exit(1)
  }
  // Keep the process alive; the server holds the event loop.
  continue_forever: {}
} else {
  console.error(`unknown verb: ${verb}`)
  console.error(HELP)
  process.exit(64)
}
