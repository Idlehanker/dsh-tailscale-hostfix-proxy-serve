# hostfix-proxy

让「只信任 loopback 的后端」在 TLS 反向代理后面正常工作。

[English](README.md) | 简体中文

```
浏览器
  └─ https://box.example.com        (TLS 终止：tailscale serve / Caddy / nginx)
       └─ http://127.0.0.1:18682    (hostfix-proxy —— 改写 Host 与 Origin)
            └─ http://127.0.0.1:18680   (你的应用，一行代码都不用改)
```

## 它要解决的问题

有一整类本地服务，靠检查 `Host` 头来防御 DNS rebinding。写法通常是这两种之一：

```js
// 白名单
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return forbidden()

// 地址比对
if (req.headers.host !== req.socket.localAddress) return forbidden()
```

**直连**时两者都正确。但放在反向代理后面就永远无法成立——浏览器必须发公网域名
（`Host: box.example.com`），而 socket 落在 `127.0.0.1`。任何字符串比较都变不出相等，
于是服务**对每个请求都回 403**，前端静默丢数据。

正解在上游：比对 `Origin` 与 `Host`，或接受显式白名单。这个代理是部署层的变通方案：
改写守卫实际读取的那两个头，让**未经修改**的后端看到一个 loopback 请求。

## 安装

```sh
npm install -g github:Idlehanker/hostfix-proxy
```

不安装直接跑：

```sh
npx github:Idlehanker/hostfix-proxy check --target 18680
```

## 使用

你真正会问的两个问题，各对应一条命令。

### 1. 我的后端是否受影响？

```sh
hostfix-proxy check --target 18680
```

```
target        : 127.0.0.1:18680/
proxy         : 127.0.0.1:18682
Host sent     : example.invalid  (故意用一个非 loopback 名字)

direct        : 403
via proxy     : not running

This is the bug this tool fixes, and the proxy is not running yet:
  hostfix-proxy start --target 18680
```

探针会**故意发一个外来 Host**，再比对直连与经代理的返回。这一步把「服务挂了」和
「服务拒绝代理请求」区分开——而人遇到 403 时的第一反应通常是怀疑凭据或端口。

### 2. 启动

```sh
hostfix-proxy start --target 18680 --listen 18682
```

然后把终止层从应用改指向代理：

```sh
# tailscale
tailscale serve --bg --https=18681 http://127.0.0.1:18682

# caddy
# box.example.com { reverse_proxy 127.0.0.1:18682 }

# nginx
# location / { proxy_pass http://127.0.0.1:18682; }
```

### 3. 常驻

macOS launchd：先手动跑通，再包进带 `KeepAlive` 的 LaunchAgent（见 `docs/OPERATIONS.md`）。

systemd：

```ini
[Service]
ExecStart=/usr/local/bin/hostfix-proxy start --target 18680 --listen 18682
Restart=always
RestartSec=10
```

### 没有 `stop` 子命令

这个进程本就该被守护。停它应该通过信号守护进程来完成；再提供一条停的路径，只会让
「它到底在不在跑」这件事有两种可能出错的说法。

## 它改了什么

只改两个请求头：

| 请求头 | 改成 | 说明 |
|---|---|---|
| `host` | `<目标主机>:<目标端口>` | 用**目标**端口，不是前置端口 |
| `origin` | `http://<目标主机>:<目标端口>` | **仅在客户端原本发了 Origin 时** |

`x-forwarded-host` 直接删掉而不是改写：它是转发层对原始名字的备注，把公网名字留在
某个头里，只会诱使后来的读者去信任它。

其余全部原样透传：方法、路径、查询串、正文、Cookie、状态码、响应头、响应流。
**WebSocket 升级也会代理**——一个能加载却连不上 socket 的界面，看起来像应用坏了而不是
代理坏了，那种 bug 排查成本高得多。

客户端没发 `Origin`，就绝不凭空造一个。凭空注入会把非浏览器请求伪装成浏览器请求，
而服务端确实会根据这个分支。

## 这算安全漏洞吗

它没有扩大可达面：

- 监听**只绑 127.0.0.1**——这是承重设计，不是默认值，所以网络上无法直连该端口；
- 唯一入口是已经完成客户端身份验证的 TLS 终止层；
- 因此改写只作用于**已经通过那道门**的流量，没有暴露任何原本不可达的路由。

它确实改变的是：守卫不能再仅凭 `Host` 区分「我的代理」和「攻击者域名」。但它们本来也
区分不了——那正是这个 bug。而它们想防的 DNS rebinding，通常由**写入路径**负责，那里比
对 `Origin` 与 `Host`，在代理下照常生效。

## 作为库使用

```js
import { startProxy } from 'hostfix-proxy'

const { server, address } = await startProxy({ port: 18682, targetPort: 18680 })
```

另外导出 `createProxy`、`rewriteHeaders`、`stripHopByHop`、`serializeHead`，
便于脱离 CLI 测试或复用。

## 测试

```sh
npm test
```

12 个测试，全部对着**能复现真实故障的夹具**——一个对任何非 loopback Host 都回 403 的
HTTP 服务——而不是一个来者不拒的 echo 服务。能通过 echo 测试的代理，仍可能在唯一重要的
那个场景上失败。

两个行为经过变异验证：去掉 Host 改写会让 5 个测试失败；去掉升级转发会让 WebSocket 那个
测试失败。

## 许可

MIT
