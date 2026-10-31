# dsh-tailscale-hostfix-proxy-serve

Make a loopback-only back end work behind a TLS terminator.

[English](README.md) | [简体中文](README.zh.md)

```
browser
  └─ https://box.example.com        (TLS terminator: tailscale serve / Caddy / nginx)
       └─ http://127.0.0.1:18682    (dsh-tailscale-hostfix-proxy-serve — rewrites Host + Origin)
            └─ http://127.0.0.1:18680   (your app, unchanged)
```

## About the name

It is long on purpose. Each segment answers a question you would otherwise have
to open the README to ask:

| segment | answers |
|---|---|
| `dsh-` | this was written for DeepSeek Harness, though nothing in it is DSH-specific |
| `tailscale-` | the terminator this was built against |
| `hostfix` | what it does: repair the Host header |
| `proxy-serve` | how: a proxy in front of `tailscale serve` |

Searchability is the other reason. A tool that fixes one specific 403 either
shows up when someone searches that symptom, or it does not — and `hostfix-proxy`
would have been indistinguishable from a hundred unrelated proxies.

## The bug this exists for

A whole family of local servers defends against DNS rebinding by inspecting the
`Host` header. The check is usually one of:

```js
// allow-list
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return forbidden()

// address compare
if (req.headers.host !== req.socket.localAddress) return forbidden()
```

Both are correct for a **direct** connection. Both are unsatisfiable behind a
reverse proxy, where the browser must send the public name
(`Host: box.example.com`) while the socket lands on `127.0.0.1`. No string
comparison can make those equal, so the server answers **403 to every request**
and its UI silently loses data.

The right fix belongs upstream — compare `Origin` to `Host`, or accept an
explicit allow-list. This proxy is the deployment-level workaround: it rewrites
the two headers the guards read, so an **unmodified** back end sees a loopback
request.

## Install

```sh
npm install -g github:Idlehanker/dsh-tailscale-hostfix-proxy-serve
```

Or run it with no install at all:

```sh
npx github:Idlehanker/dsh-tailscale-hostfix-proxy-serve check --target 18680
```

## Use

Both questions you actually have are one command each.

### 1. Is my back end affected?

```sh
dsh-tailscale-hostfix-proxy-serve check --target 18680
```

```
target        : 127.0.0.1:18680/
proxy         : 127.0.0.1:18682
Host sent     : example.invalid  (a deliberately non-loopback name)

direct        : 403
via proxy     : not running

This is the bug this tool fixes, and the proxy is not running yet:
  dsh-tailscale-hostfix-proxy-serve start --target 18680
```

The probe sends a **deliberately foreign** Host and compares the direct answer
with the proxied one. That is what separates "the service is down" from "the
service refuses proxied requests" — the usual first guess is that the credential
or the port is wrong.

### 2. Run it

```sh
dsh-tailscale-hostfix-proxy-serve start --target 18680 --listen 18682
```

Then point the terminator at the proxy instead of the app:

```sh
# tailscale
tailscale serve --bg --https=18681 http://127.0.0.1:18682

# caddy
# box.example.com { reverse_proxy 127.0.0.1:18682 }

# nginx
# location / { proxy_pass http://127.0.0.1:18682; }
```

### 3. Keep it running

macOS launchd:

```sh
dsh-tailscale-hostfix-proxy-serve start --target 18680   # verify by hand first
# then wrap it in a LaunchAgent with KeepAlive — see docs/OPERATIONS.md
```

systemd:

```ini
[Unit]
Description=dsh-tailscale-hostfix-proxy-serve
After=network.target

[Service]
ExecStart=/usr/local/bin/dsh-tailscale-hostfix-proxy-serve start --target 18680 --listen 18682
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

### There is no `stop` verb

The process is meant to be supervised. Signalling the supervisor is the stop
path, and adding a second one here would only create two ways to be wrong about
whether it is running.

## What it changes

Exactly two request headers:

| header | rewritten to | notes |
|---|---|---|
| `host` | `<target-host>:<target-port>` | built from the **target** port, not the front-door port |
| `origin` | `http://<target-host>:<target-port>` | **only when one was sent** |

`x-forwarded-host` is dropped rather than rewritten: it is the forwarder's note
about the original name, and leaving the public name in a header only invites a
future reader to trust it.

Everything else passes through byte for byte: method, path, query, body, cookies,
status, response headers, and the response stream. **WebSocket upgrades are
proxied** — a UI that loads but cannot open its socket looks like a broken app
rather than a broken proxy, which is a far more expensive bug to chase.

An `Origin` the client did not send is never invented. Injecting one would turn
a non-browser request into a browser-shaped one, and servers do branch on that.

## Is this a security hole?

It does not widen the reachable surface:

- the listener binds **127.0.0.1 only** — this is load-bearing, not a default, so
  nothing on the network can reach the port directly;
- the only path in is the TLS terminator, which has already authenticated the
  client;
- the rewrite therefore applies to traffic that already cleared that front door.
  It exposes no route that was not reachable through the same front door.

What it does change: the guards can no longer use `Host` alone to tell your
proxy from an attacker's domain. They already could not — that is the bug — and
the DNS-rebinding defence they intend usually lives in their **write** paths,
which compare `Origin` against `Host` and keep working under the proxy.

## Library use

```js
import { startProxy } from 'dsh-tailscale-hostfix-proxy-serve'

const { server, address } = await startProxy({ port: 18682, targetPort: 18680 })
console.log('listening on', address.port)
```

`createProxy`, `rewriteHeaders`, `stripHopByHop` and `serializeHead` are exported
too, so the parts can be tested or reused without the CLI.

## Tests

```sh
npm test
```

Twelve tests, all against a **fixture that reproduces the real failure** — an
HTTP server that 403s any non-loopback Host — rather than a permissive echo
server. A proxy that passes an echo test can still fail the only case that
matters.

Two behaviours are mutation-verified: disabling the Host rewrite fails five
tests, disabling the upgrade relay fails the WebSocket one.

## License

MIT
