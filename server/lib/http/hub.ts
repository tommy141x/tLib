// The index page at `/`, plus the router's own error pages.
//
// Self-contained on purpose: inline CSS, no external assets, no framework. The
// hub has to render before any mount is up, and asset routes for it would carve
// reserved paths out of the mount namespace.
//
// The index is public and unauthenticated by design; each mount keeps its own
// auth. Being listed affects discovery only, never routing or access.

// THERE WAS A DIAGNOSTICS PANEL HERE, AND IT IS GONE ON PURPOSE.
//
// It reported the `tlib_telemetry` convar read-only — the state, the convar's
// value, the queue depth, the breaker, and the per-install-id disclosure. The
// owner removed it: the hub is app discovery, not a settings surface. Before
// that, a state-changing switch had already been removed from the same panel,
// because this listener binds `0.0.0.0` by default and the index is public and
// unauthenticated with no auth primitive in `server/lib/http/` to gate anything
// with. So neither half is to be rebuilt here:
//
//   • the setting's state → `tlib_telemetry_status` in the server console;
//   • the per-install-id disclosure → `docs/content/convars.mdx`, under
//     "What this convar does *not* cover: the per-install id". That disclosure
//     is load-bearing (browse, community configs and the update check send the
//     id whether diagnostics are on or off) — it moved, it was not dropped.
//
// `hub.test.ts` keeps the read-only guard that stops a control reappearing.

import { ICON_VIEWBOX, iconBody } from "./icons";
import { type HubDestination, hubDestinations, type Mount } from "./registry";

/**
 * Every value here comes from the registering resource and none is trusted:
 * title and description are escaped, and the accent reaches the page through a
 * custom property the registry has already matched against a hex pattern. The
 * icon is raw only because the resource supplies a name and the markup is tLib's
 * own.
 */
function renderCard(m: HubDestination): string {
  const style = m.accent ? ` style="--accent:${m.accent}"` : "";
  const subtitle = m.description
    ? `<div class="desc">${escapeHtml(m.description)}</div>`
    : `<div class="path">${escapeHtml(m.path)}</div>`;

  return `<li><a class="card" href="${escapeHtml(m.path)}"${style}>
<span class="ico" aria-hidden="true"><svg viewBox="${ICON_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconBody(m.icon)}</svg></span>
<div class="text"><div class="name">${escapeHtml(m.title || m.id)}</div>${subtitle}</div>
<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span></a></li>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHELL = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--surface:#111;--border:#292929;--muted:#a3a3a3;--radius:6px}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;
  background:#0a0a0a;color:#f5f5f5;
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(840px,100%);min-width:0;padding:48px 24px}
h1{margin:0 0 6px;font-size:24px;font-weight:600;letter-spacing:-.025em;overflow-wrap:anywhere}
.sub{margin:0 0 24px;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
ul{list-style:none;margin:0;padding:0;
  display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
li{min-width:0}
a.card{--accent:#d4d4d4;
  display:flex;align-items:center;gap:14px;height:100%;min-height:96px;padding:18px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  color:inherit;text-decoration:none}
/* The hover tint is instant. This is a grid of cards, and a .15s fade behind a
   cursor crossing them is the one thing that makes a static page feel slow. */
a.card:hover{background:#191919;border-color:#525252}
a:focus-visible{outline:2px solid #fafafa;outline-offset:4px}
.ico{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:var(--radius);
  color:var(--accent);background:#1c1c1c;border:1px solid var(--border)}
.ico svg{width:20px;height:20px;display:block}
.text{min-width:0;overflow-wrap:anywhere}
.name{font-size:16px;font-weight:600;line-height:1.4}
.desc{color:var(--muted);font-size:14px;margin-top:4px}
.path{color:var(--muted);font-size:14px;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.chev{margin-left:auto;flex:none;color:#a3a3a3}
.chev svg{display:block;width:18px;height:18px}
.empty{padding:20px;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);color:var(--muted);font-size:14px}
.err{font-size:44px;font-weight:600;margin:0 0 12px;letter-spacing:-.025em}
code{background:#202020;padding:2px 6px;border-radius:4px;font-size:14px}
footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:14px}
footer a{display:inline-flex;align-items:center;min-height:44px;color:#d4d4d4;text-underline-offset:4px}
footer a:hover{color:#fff}
@media(max-width:600px){main{padding:32px 20px}ul{grid-template-columns:minmax(0,1fr)}a.card{padding:16px;gap:12px}}
@media(forced-colors:active){a:focus-visible{outline-color:Highlight}}
</style></head>
<body><main>${body}</main></body></html>`;

/** Counts visible destinations, not proxy mounts. */
export function renderIndex(mounts: Mount[], serverName: string): string {
  const destinations = hubDestinations(mounts);
  const body =
    destinations.length === 0
      ? `<h1>${escapeHtml(serverName)}</h1>
<p class="sub">tLib router</p>
<div class="empty">No destinations are listed on this hub.
Resources may still be available at their direct URLs.</div>`
      : `<h1>${escapeHtml(serverName)}</h1>
<p class="sub">${destinations.length} ${destinations.length === 1 ? "destination" : "destinations"} available</p>
<ul>${destinations.map(renderCard).join("")}</ul>`;

  return SHELL(serverName, `${body}<footer>tLib</footer>`);
}

/** 404 for no mount, 502 for a dead upstream. */
export function renderError(code: number, title: string, detail: string): string {
  return SHELL(
    `${code} ${title}`,
    `<p class="err">${code}</p><h1>${escapeHtml(title)}</h1>
<p class="sub">${detail}</p>
<footer><a href="/">&larr; Back to the hub</a></footer>`
  );
}

export function notFoundPage(pathname: string): string {
  return renderError(
    404,
    "Not found",
    `Nothing is mounted at <code>${escapeHtml(pathname)}</code>.`
  );
}

export function badGatewayPage(mount: Mount): string {
  return renderError(
    502,
    "Resource unavailable",
    `<code>${escapeHtml(mount.mount)}</code> is registered by ` +
      `<code>${escapeHtml(mount.resourceName)}</code> but is not responding. ` +
      `It may still be starting up.`
  );
}
