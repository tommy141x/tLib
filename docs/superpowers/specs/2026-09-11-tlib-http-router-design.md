# tLib HTTP Router — Design

**Date**: 2026-09-11
**Status**: Approved for planning
**Scope**: tLib (new `server/http/`, rewrite of `server/realtime/` transport), tRadio v7, tDB

---

## Goal

tLib owns **one** externally-listening TCP port for the whole server. Every web
surface any tScripts resource wants to expose is reached through it, under a path
prefix. tLib alone is useful (it serves a hub page and its own realtime socket).
Drop in tRadio and `/dispatch` appears. Drop in tDB and `/db` appears. Remove
either and its mount disappears. No operator configuration is required for the
common case.

This replaces the status quo of four separately-bound public ports:

| resource | listener today | binds today |
|---|---|---|
| tRadio | `node:http` + Socket.IO | `[::]:7777` (`server/lib/events.ts:826`) |
| tLib realtime | `ws` `WebSocketServer` | `0.0.0.0:30125` (`server/realtime/config.ts:14`) |
| tDB | PocketBase 0.40.3 child process | `0.0.0.0:8090` (`config.lua:41`) |
| FXServer | game + its own HTTP handler | `0.0.0.0:30120` (`server.cfg:24`) |

After this change only the FXServer game port and the tLib router port listen
externally. FXServer's port is out of scope — it is the game transport.

## Non-goals

- **TLS.** The router terminates plain HTTP only. Certificate acquisition,
  storage, renewal and reload inside an FXServer Node bundle is a large surface
  with poor ergonomics. Operators wanting HTTPS front it with Cloudflare, pingap,
  nginx or Caddy. Consequence, stated plainly: on a bare `ip:port` server the hub
  and everything behind it are `http://`, and tRadio's `_cookieSecureFlag`
  (`server/lib/http.ts:302`) will correctly decline to set `Secure`. This is the
  status quo today, not a regression — but the hub concentrates more behind one
  door, so it is a larger prize.
- **Single sign-on.** The hub is a public index. Each mount keeps its own auth.
- **Replacing FXServer's `SetHttpHandler`.** Unused across both repos today and
  left unused; it cannot do WebSocket upgrades, so it cannot carry Socket.IO.

## Decisions

| decision | choice | why |
|---|---|---|
| Audience | ships to tRadio customers | must work on a bare `ip:port` box with no proxy, DNS or TLS; cannot lean on pingap |
| Addressing | path prefixes | subdomains need wildcard DNS + certs, which a bare-IP FiveM server does not have |
| Migration | hard cutover in tRadio v7 | one code path; avoids maintaining dual-bind indefinitely |
| Hub auth | public index | smallest build; no disruption to tRadio's existing Discord OAuth/session layer |
| Realtime | folded into the router at `/rt` | this is **the** port; verified zero consumers, so it is free |

---

## Why tLib cannot host other resources' routes

The original framing was "tRadio registers its route handlers with tLib". This is
not implementable and the design works around it.

Each FiveM resource's Node bundle runs in a **separate V8 isolate**. Exports
across that boundary marshal values. A live `IncomingMessage`/`ServerResponse`
pair is a socket-backed stream and is not marshalable — tRadio cannot hand its
request object to tLib's listener, nor the reverse. tDB (a Go binary) and any
customer's third-party app hit the same wall more obviously.

Therefore tLib is a **reverse proxy**. Backends keep their own listeners and
rebind to loopback. This is uniform across every backend kind, and it keeps
tRadio's 3,900-line `handleRequest` dispatcher (`server/lib/http.ts:590`)
untouched.

The one exception is tLib's *own* realtime socket, which lives in tLib's own
bundle and therefore needs no proxying — it attaches in-process. Hence two mount
kinds.

---

## Architecture

### Module layout

`server/http/` in tLib, mirroring the existing `server/realtime/` so it reads as
house style:

| file | role |
|---|---|
| `config.ts` | convars `tlib_http_port`, `tlib_http_host`, `tlib_http_public_url` |
| `registry.ts` | mount table; modeled on `server/marketplace/registry.ts:15-41` |
| `proxy.ts` | `request` + `upgrade` forwarding, header rewriting |
| `hub.ts` | index page at `/` |
| `bridge.ts` | `fExports` for Lua, like `server/realtime/bridge.ts:43-90` |
| `index.ts` | `installHttp()`, called from `server/main.ts` |
| `imports/http/server.lua` | consumer-facing facade |

**Install eagerly, not lazily.** `server/realtime/index.ts:29-49` opens its port
on first use, but `server/marketplace/index.ts:52-62` already documents the
reason not to: a race where consumer Lua runs before the Node `onResourceStart`
handler. A backend registering a mount hits exactly that race, so the router
follows marketplace's precedent.

### Default port

`tlib_http_port` defaults to **7777** — tRadio's historical port. Since tRadio v7
is a hard cutover anyway, every existing customer already has 7777 open in their
firewall and forwarded in NAT. Reusing it means the upgrade changes *paths* but
not *networking*, which is the half of a migration that cannot be talked through
over Discord. A generic tLib convar defaulting to tRadio's port is odd; the
migration win is worth it.

`tlib_http_host` defaults to `0.0.0.0`. This is the only externally-bound socket.

### Mount kinds

```ts
type Mount = {
  id: string;              // 'radio'
  mount: string;           // '/dispatch'  (leading slash, no trailing)
  title: string;           // 'Dispatch'   — hub display
  listed: boolean;         // false = routable but hidden from the index
  resource: string;        // owner, for onResourceStop cleanup
} & (
  | { kind: 'proxy';      upstream: { host: string; port: number };
                          stripPrefix: boolean; websocket: boolean }
  | { kind: 'inprocess';  onRequest?: Handler; onUpgrade?: UpgradeHandler }
);
```

`kind: 'inprocess'` is only reachable from tLib's own bundle, by construction —
the isolate wall means no other resource could pass a handler function anyway.

### Registration contract

Runtime export, **not** `tlib_web` fxmanifest metadata. This breaks from the
`tlib_modules` convention (`imports.lua:131-138`) deliberately: manifest metadata
is static, but the upstream port is a runtime value (tRadio's from
`config/config.lua:33`, tDB's from its own `config.lua`), and — more importantly
— a mount is only valid once the upstream is *actually listening*. A manifest
cannot express readiness.

```lua
exports['tLib']:RegisterWebApp({
  id = 'radio',
  mount = '/dispatch',
  upstream = { host = '127.0.0.1', port = Config.serverPort },
  stripPrefix = false,
  websocket = true,
  title = 'Dispatch',
  listed = true,
})
```

Called from the backend's own "listener is up" callback. Auto-unregistered on
`onResourceStop`, exactly as `server/marketplace/index.ts:46-50` does.

**Mount collision**: first registration wins. The second is refused and logged at
error level with both resource names. Silent override would make a
misconfiguration look like a routing bug.

**Drag-and-drop**: each resource ships its own default mount, so the common case
needs no operator config. An operator override is read from the resource's own
config (e.g. `Config.mountPath`), not from tLib.

### stripPrefix, per mount

- `stripPrefix: false` — forward the path intact; the backend genuinely serves
  under `/dispatch/...`. Zero rewriting anywhere, because there is only one URL
  space. **Use for resources we control (tRadio).**
- `stripPrefix: true` — strip the mount before forwarding and send
  `X-Forwarded-Prefix`. tLib then rewrites `Set-Cookie` `Path=` and `Location:`
  on 3xx. **Use for software we cannot modify (tDB/PocketBase, third-party).**

No body rewriting in either mode, ever. Rewriting absolute URLs inside HTML/JS
means parsing hashed bundles, handling gzip, and abandoning streaming — and it
still cannot fix a client-side hardcoded path like Socket.IO's.

---

## Proxy mechanics

### Matching

Normalize the path **before** matching: resolve `.`/`..`, collapse `//`. Matching
a raw path lets `/dispatch/../admin` select the wrong mount. Then longest-prefix
wins; `/` falls through to the hub; no match is a 404.

### Forwarding

- **`request`** → `http.request({ host, port, path, method, headers })`, then
  `req.pipe(upstream)` and `upstream.pipe(res)`. Fully streaming — required
  because tRadio serves `imbe_dvm.wasm`, whole `layouts/**` skin trees, and the
  updater `.exe`.
- **`upgrade`** → same request, replay the `101` with upstream headers, unshift
  any `head` bytes, then `usock.pipe(socket); socket.pipe(usock)`. Required for
  Socket.IO's WebSocket transport; without it Socket.IO silently degrades to
  long-polling forever and *looks like it works*.

Headers set outbound: `X-Forwarded-For`, `-Proto`, `-Host`, and `-Prefix` (for
`stripPrefix: true` mounts). Hop-by-hop headers stripped in **both** directions
per RFC 9110 — `connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`,
`trailer`, `proxy-authorization`, `proxy-authenticate`.

Upstream unreachable → **502 from the hub**, never a hung socket. tRadio binds
late (on `radio:initServer`, gated on `radio:nodeReady`, `server/sv_radio.lua:584`),
so "registered but not yet listening" is a normal startup state.

### Security rules

Non-negotiable, because this ships to strangers' servers.

1. **Never an open proxy.** Upstream is chosen *only* by registry match.
   Absolute-form request URIs (`GET http://evil/ HTTP/1.1`) and the `Host` header
   must never influence upstream selection. Getting this wrong turns every
   customer's box into an open relay.
2. **Loopback-only upstreams.** `RegisterWebApp` rejects any host that is not
   `127.0.0.1` or `::1`. A registry accepting arbitrary hosts is SSRF as a
   feature.
3. **Strip inbound `X-Forwarded-*`** before setting our own, so a client cannot
   spoof its source IP into a backend's rate limiter. tRadio's federation limiter
   (`server/lib/http.ts:84`) buckets per-IP and would otherwise be trivially
   bypassed.
4. **Connection cap** on the router to bound socket exhaustion.

### Hub

`GET /` renders the index of mounts with `listed: true`. If exactly **one** mount
is listed, `/` issues a 302 to it instead of rendering a chooser. A 502 page for
a registered-but-down upstream is also served here.

---

## Realtime migration

`server/realtime/` stops owning a socket. `server/realtime/server.ts:76` changes
from `new WebSocketServer({ host, port, ... })` to
`new WebSocketServer({ noServer: true })`, and the router's `upgrade` handler
calls `wss.handleUpgrade(req, socket, head, cb)` for the `/rt` mount. The
protocol, session, token and room layers (`protocol.ts`, `sessions.ts`,
`rooms.ts`) are untouched.

Removed: `tlib_realtime_port`, `tlib_realtime_host`. `tlib_realtime_public_url`
becomes derived from `tlib_http_public_url` + `/rt`.

**Blast radius: zero.** No resource in the tree declares `realtime` in
`tlib_modules` (verified across tAFK, tELS, tDetector, tAI, tRadio), and nothing
references `rtIssueToken`, `rtSetRooms` or `tlib.realtime`. Port 30125 is
currently bound on `0.0.0.0` serving nobody.

`server/realtime/control.ts` is an **outbound** client to a remote service and is
unaffected.

Future realtime consumers share this one socket via the existing room system
rather than opening new ports.

---

## tRadio v7 change list

The long pole. tLib's router is small; this is where the work is.

| # | change | location |
|---|---|---|
| 1 | bind `127.0.0.1` instead of `"::"` | `server/lib/events.ts:826` |
| 2 | call `RegisterWebApp` from `onListening` | `server/lib/events.ts` |
| 3 | Socket.IO **server** `path: '/dispatch/socket.io/'` | `server/main.ts:78` |
| 4 | Socket.IO **client** path to match | client bundle + `client/screen.html` |
| 5 | `/socket.io/` skip-guard uses the new prefix | `server/lib/http.ts:604` |
| 6 | admin cookie `Path=/admin` → `/dispatch/admin` | `server/lib/http.ts:307` |
| 7 | `<base href>` emits the mount, not `"/"` | `server/lib/http.ts:2877` |
| 8 | Discord OAuth `redirect_uri` gains the prefix | `server/lib/auth.ts:12` |
| 9 | `/audio/*` → `/layouts/sounds/*` 301 target | `server/lib/http.ts:786` |
| 10 | CORS allowlist + `state.serverUrl` become the hub origin | `server/lib/http.ts:376` |
| 11 | federation peer URLs gain the prefix | `Config.serverAddress`, `config/config.lua:23` |
| 12 | `Config.serverPort` redocumented — loopback, no longer firewalled | `config/config.lua:33` |

tRadio uses `stripPrefix: false`: it already generates every one of its own URLs,
so teaching it a `MOUNT` constant is cleaner than having tLib rewrite headers
underneath it. Items 6–9 become that constant applied at each generation site.

Items 3–5 are the expected debugging cost, because Socket.IO falling back to
polling presents as working.

`isSatelliteServer` (`config/config.lua:29`) early-returns before any listen
(`server/lib/events.ts:462`); satellites register no mount.

---

## tDB integration

tDB's Lua spawns PocketBase as a child process
(`add_unsafe_child_process_permission tDB`, `server.cfg:53`) and then registers:

- `Config.ExposeAdmin` is removed. PocketBase always binds `127.0.0.1` via
  `--http 127.0.0.1:<port>`. External reachability is now the router's decision,
  not PocketBase's.
- `Config.Port` (`config.lua:41`) becomes an internal loopback port, no longer
  firewalled.
- Mount `/db`, `stripPrefix: true`, `websocket: false` (PocketBase realtime is
  SSE over plain HTTP, not WebSocket).
- `listed` defaults to `false`. An anonymous index advertising "PocketBase admin
  here" is a map for an attacker; it stays routable at `/db`.

**Remote PocketBase mode** (`Config.Advanced.RemoteHost`/`RemotePort`,
`config.lua:150-151`) starts no local process and points at an arbitrary remote
host. In this mode tDB **registers no mount at all**. Proxying to it would
require relaxing the loopback-only rule to accept operator-supplied remote hosts,
which reintroduces exactly the SSRF surface that rule exists to close. A remote
PocketBase already has its own reachable URL; the operator uses it directly. The
router exists to expose *local* services on one port, and that invariant holds
without exception.

---

## Spike results (2026-09-11)

All core mechanics were proven with throwaway prototypes before this spec was
written. Prototype code was discarded.

| mechanic | result |
|---|---|
| PocketBase admin at `/db/_/` via proxy | **200** |
| PocketBase API at `/db/api/health` | **200**, healthy |
| PocketBase asset at `/db/_/assets/*` | **200** |
| `307` on `/db/_` | `Location` rewritten to `/db/_/` correctly |
| PocketBase SSE `/db/api/realtime` | `PB_CONNECT` streamed, unbuffered |
| unmounted path | **404** |
| in-process WS mount `/rt` (`noServer` + `handleUpgrade`) | echo OK |
| proxied WS upgrade `/dispatch/*` | echo OK |

**The PocketBase subpath risk is resolved.** PocketBase 0.40.3 has no
`--basepath` flag, but needs none: its admin HTML emits **relative** asset paths
(`./assets/...`), and its SDK client is constructed as `new Ee("../")` — a
relative baseURL, which `buildURL` resolves against `window.location.pathname`:

```js
baseURL.startsWith(`/`)||(n+=window.location.pathname||`/`)
```

So served at `/db/_/` it calls `/db/api/...` unaided. PocketBase mounts at an
arbitrary prefix with **zero modification**.

---

## Testing

- **Unit** — path normalization (`..`, `//`, encoded traversal), longest-prefix
  match, hop-by-hop stripping, `Set-Cookie`/`Location` rewriting, mount collision
  refusal, loopback-only validation.
- **Security** — absolute-form request URI must not select an upstream; `Host`
  header must not select an upstream; inbound `X-Forwarded-For` must not survive.
- **Integration** — a fixture upstream exercising HTTP, SSE, WebSocket upgrade,
  a large streamed body, and an upstream that is registered but not listening
  (expect 502, not a hang).
- **Manual, in-game** — tRadio dispatch panel and admin panel through the mount,
  in-game NUI radio audio (confirms Socket.IO took the **WebSocket** transport,
  not polling — assert transport explicitly), tDB admin through `/db`, and
  resource stop/start re-registering the mount.

No Lua interpreter exists on this machine; Lua changes are checked statically
(see project CLAUDE.md).

---

## Open items for planning

1. **Build order.** tLib's router must ship and be released before tRadio v7 can
   depend on it. `tlib_min_version` gate rises from `0.6`.
2. **Should the hub be themable?** tLib has a theme module
   (`lua/theme/`); the hub could consume it. Deferred unless cheap.
3. **tCAD** is not a FiveM resource (no `fxmanifest.lua`) — it is a standalone
   SolidStart/Vinxi app. It can be mounted, but nothing in FiveM can call
   `RegisterWebApp` on its behalf. Needs either a thin companion resource or a
   static mount entry in tLib config. Out of scope for v1; the registry design
   does not preclude it.
