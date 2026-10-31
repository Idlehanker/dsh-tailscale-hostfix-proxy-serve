# Operations

## macOS (launchd)

The process is meant to be supervised; `KeepAlive` is what makes a crash a
non-event.

`~/Library/LaunchAgents/com.local.hostfix-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.hostfix-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/hostfix-proxy</string>
    <string>start</string>
    <string>--target</string><string>18680</string>
    <string>--listen</string><string>18682</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- A restart loop against a port that is genuinely taken is noise; wait. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/hostfix-proxy.log</string>
  <key>StandardErrorPath</key><string>/tmp/hostfix-proxy.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.hostfix-proxy.plist
launchctl print gui/$(id -u)/com.local.hostfix-proxy | grep -E "state|pid"
```

## launchd and version-managed Node

If node comes from nvm / asdf / volta, do NOT point the agent at the npm bin
shim (`/path/to/bin/hostfix-proxy`). That file is `#!/usr/bin/env node`, and
launchd gives the agent a minimal PATH without your version manager, so it dies
with:

```
env: node: No such file or directory
```

...while `state = spawn scheduled` and `KeepAlive` retries forever. Run node as
the interpreter and the CLI as its argument instead:

```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/you/.nvm/versions/node/v22.x/bin/node</string>
  <string>/Users/you/.nvm/versions/node/v22.x/lib/node_modules/hostfix-proxy/bin/cli.js</string>
  <string>start</string>
  <string>--target</string><string>18680</string>
  <string>--listen</string><string>18682</string>
</array>
```

Resolve both paths with `command -v node` and `npm root -g`, and re-check them
after any node upgrade.

## Health

```sh
hostfix-proxy check --target 18680
```

Exit codes are meant for supervisors and alerting:

| code | meaning |
|---|---|
| 0 | healthy through the proxy, or the back end never needed it |
| 1 | back end unreachable — the app is down, not the proxy |
| 2 | back end refuses non-loopback Host and the proxy is not running |
| 3 | proxy is running but its answer differs from the direct answer |

## Order of startup

The proxy holds no state, so it can start before or after the app. It does not
retry: a request arriving while the back end is down gets a 502 with a structured
body, which is more useful to a browser than a hang.

## Troubleshooting

**Everything 403s through the proxy too.** The guard is probably not Host-based.
Check what the *direct* answer is with `check`; if the back end already accepts a
foreign Host, this tool is not the answer.

**The UI loads but never connects.** Something is dropping the upgrade — a second
proxy in front, or a terminator configured for HTTP/1.0. `hostfix-proxy` relays
upgrades; verify with a WebSocket client through the proxy port itself.

**`EADDRINUSE` on start.** Another instance is already listening. The CLI exits
**0** in that case on purpose: under a supervisor, "already running" is success,
and a non-zero exit would start a restart loop.

**WebSocket handshake succeeds but frames are lost.** Node delivers the bytes
that arrive with the 101 through the `upgrade` event's third argument, not the
socket stream. This proxy relays both; a custom client that reads only the stream
will look like it is dropping data.
