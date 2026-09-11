// Throwaway: load the REAL shipped server/bundle.js with stubbed FiveM globals
// and drive the router the way tRadio/tDB would.
const path = require("node:path");

const convars = {
  tlib_http_port: "7799", // not 7777, so this never fights a live server
  tlib_http_host: "127.0.0.1",
  sv_hostname: "^2Smoke ^7Test",
};

const registered = new Map();
const handlers = new Map();
let invoking = "tRadio";

Object.assign(globalThis, {
  exports: (name, fn) => registered.set(name, fn),
  on: (evt, fn) => handlers.set(evt, fn),
  onNet: (evt, fn) => handlers.set(evt, fn),
  emit: () => {},
  emitNet: () => {},
  GetConvar: (n, d) => convars[n] ?? d,
  GetConvarInt: (n, d) => Number(convars[n] ?? d),
  GetCurrentResourceName: () => "tLib",
  GetInvokingResource: () => invoking,
  GetResourcePath: () => path.join(__dirname),
  GetResourceState: () => "started",
  GetPlayers: () => [],
  GetNumResources: () => 0,
  GetResourceByFindIndex: () => null,
  GetResourceMetadata: () => null,
  GetNumResourceMetadata: () => 0,
  AddEventHandler: (evt, fn) => handlers.set(evt, fn),
  RegisterNetEvent: () => {},
  setTick: () => {},
  IsDuplicityVersion: () => true,
});

console.log("loading bundle…");
// Load WITHOUT Node's CommonJS wrapper. Node's wrapper injects a local
// `exports` (module.exports) that shadows the global one; FiveM does not, which
// is why the bundle's bare `exports("Name", fn)` calls work in production.
// Reproducing FiveM's scope is the whole point of this harness.
{
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./server/bundle.js"), "utf8");
  const mod = { exports: {} };
  // Params deliberately omit `exports` so it resolves to the global stub.
  new Function("require", "module", "__dirname", "__filename", src)(
    require,
    mod,
    path.join(__dirname, "server"),
    path.join(__dirname, "server", "bundle.js")
  );
}
console.log("loaded. exports registered:", [...registered.keys()].join(", ") || "(none)");

(async () => {
  await new Promise((r) => setTimeout(r, 600));

  const reg = registered.get("RegisterWebApp");
  if (!reg) {
    console.log("FAIL: RegisterWebApp was never registered");
    process.exit(1);
  }

  // Exactly tRadio's payload.
  const r1 = reg({
    id: "radio",
    mount: "/dispatch",
    port: 30125,
    host: "127.0.0.1",
    stripPrefix: true,
    websocket: true,
    title: "Dispatch",
    icon: "radio-tower",
    description: "Radio channels, units and live dispatch",
    accent: "#4f8ef7",
    listed: true,
  });
  console.log("RegisterWebApp(tRadio) ->", JSON.stringify(r1));

  invoking = "tDB";
  const r2 = reg({
    id: "db",
    mount: "/db",
    port: 8090,
    host: "127.0.0.1",
    stripPrefix: true,
    websocket: false,
    title: "Database",
    listed: false,
    index: "/_/",
  });
  console.log("RegisterWebApp(tDB)    ->", JSON.stringify(r2));

  // Collision must be refused, not silently overwritten.
  invoking = "tEvil";
  console.log("collision refused      ->", JSON.stringify(reg({ mount: "/dispatch", port: 1234 })));
  console.log(
    "non-loopback refused   ->",
    JSON.stringify(reg({ mount: "/x", port: 80, host: "1.2.3.4" }))
  );

  console.log("GetHubUrl              ->", registered.get("GetHubUrl")?.());
  console.log("ListWebApps            ->", JSON.stringify(registered.get("ListWebApps")?.()));

  const base = `http://127.0.0.1:${convars.tlib_http_port}`;
  const hub = await fetch(`${base}/`, { redirect: "manual" });
  const body = await hub.text();
  console.log(
    "GET /                  ->",
    hub.status,
    hub.status === 302 ? hub.headers.get("location") : `${body.length} bytes`
  );
  console.log("   hub lists Dispatch  ->", body.includes("Dispatch"));
  // Proves icons.json was found through GetResourcePath, not just that the
  // hub rendered — a missing data file degrades silently to no icons.
  console.log("   hub draws its icon  ->", body.includes("<path d=") || body.includes("<rect"));
  console.log("   hub applies accent  ->", body.includes("--accent:#4f8ef7"));
  console.log("   hub hides Database  ->", !body.includes("Database"));
  console.log("GET /nope              ->", (await fetch(`${base}/nope`)).status);
  console.log(
    "GET /dispatch (bare)   ->",
    (await fetch(`${base}/dispatch`, { redirect: "manual" })).status,
    (await fetch(`${base}/dispatch`, { redirect: "manual" })).headers.get("location")
  );
  // PocketBase serves nothing at its root, so the bare mount must land on /_/.
  for (const p of ["/db", "/db/", "/db/?a=1"]) {
    const r = await fetch(`${base}${p}`, { redirect: "manual" });
    console.log(`GET ${p.padEnd(18)} ->`, r.status, r.headers.get("location"));
  }

  // Nothing is listening upstream, so this must be a clean 502, not a hang.
  const t0 = Date.now();
  console.log(
    "GET /dispatch/ (no up) ->",
    (await fetch(`${base}/dispatch/`)).status,
    `in ${Date.now() - t0}ms`
  );

  process.exit(0);
})();
