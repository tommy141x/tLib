// hub.ts — the index page at `/`, plus the router's own error pages.
//
// Deliberately self-contained: inline CSS, no external assets, no framework.
// The hub must render before any mount is up, and adding asset routes for it
// would carve reserved paths out of the mount namespace.
//
// The index is PUBLIC and unauthenticated by design — each mount keeps its own
// auth. Mounts registered with `listed: false` are routable but omitted here,
// so an anonymous visitor is not handed a map of the admin surfaces.

import { ICON_VIEWBOX, iconBody } from "./icons";
import type { Mount } from "./registry";

/**
 * One app card.
 *
 * Three values come from the registering resource and all three are handled as
 * untrusted: the title and description are escaped, and the accent reaches the
 * page through a custom property that the registry has already matched against
 * a hex pattern. The icon is the exception that proves the rule — the resource
 * supplies only a NAME, and the markup is looked up in tLib's own icon set, so
 * it is ours to emit raw.
 */
function renderCard(m: Mount): string {
  const style = m.accent ? ` style="--accent:${m.accent}"` : "";
  const subtitle = m.description
    ? `<div class="desc">${escapeHtml(m.description)}</div>`
    : `<div class="path">${escapeHtml(m.mount)}</div>`;

  return `<li><a class="card" href="${escapeHtml(m.mount)}/"${style}>
<span class="ico" aria-hidden="true"><svg viewBox="${ICON_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconBody(m.icon)}</svg></span>
<span class="text"><div class="name">${escapeHtml(m.title || m.id)}</div>${subtitle}</span>
<span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`;
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
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;
  background:#0d0f12;color:#e8eaed;
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:min(760px,92vw);padding:40px 0}
h1{margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-.01em}
.sub{margin:0 0 28px;color:#9aa0a6;font-size:13px}
ul{list-style:none;margin:0;padding:0;
  display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
a.card{--accent:#6b7280;
  display:flex;align-items:center;gap:16px;padding:18px;
  background:#161a1f;border:1px solid #23282f;border-radius:12px;
  color:inherit;text-decoration:none;
  transition:border-color .15s,background .15s,transform .15s}
a.card:hover{background:#1b2027;border-color:color-mix(in srgb,var(--accent) 55%,#3a4149);
  transform:translateY(-1px)}
a.card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ico{flex:none;display:grid;place-items:center;width:42px;height:42px;border-radius:10px;
  color:var(--accent);
  background:color-mix(in srgb,var(--accent) 14%,transparent);
  border:1px solid color-mix(in srgb,var(--accent) 28%,transparent)}
.ico svg{width:21px;height:21px;display:block}
.text{min-width:0}
.name{font-weight:600}
.desc{color:#9aa0a6;font-size:12.5px;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.path{color:#7f868d;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.chev{margin-left:auto;flex:none;color:#5f666d}
.empty{padding:20px;background:#161a1f;border:1px solid #23282f;
  border-radius:10px;color:#9aa0a6;font-size:13.5px}
.err{font-size:44px;font-weight:600;margin:0 0 6px;letter-spacing:-.02em}
code{background:#1b2027;padding:1px 6px;border-radius:4px;font-size:12.5px}
footer{margin-top:28px;color:#5f666d;font-size:12px}
</style></head>
<body><main>${body}</main></body></html>`;

/** The hub index. Only `listed` mounts are shown. */
export function renderIndex(mounts: Mount[], serverName: string): string {
  const body =
    mounts.length === 0
      ? `<h1>${escapeHtml(serverName)}</h1>
<p class="sub">tLib router</p>
<div class="empty">No web resources are registered yet.
Start a resource that exposes one &mdash; it will appear here automatically.</div>`
      : `<h1>${escapeHtml(serverName)}</h1>
<p class="sub">${mounts.length} ${mounts.length === 1 ? "resource" : "resources"} available</p>
<ul>${mounts.map(renderCard).join("")}</ul>`;

  return SHELL(serverName, `${body}<footer>tLib</footer>`);
}

/** Router-generated error page (404 for no mount, 502 for a dead upstream). */
export function renderError(code: number, title: string, detail: string): string {
  return SHELL(
    `${code} ${title}`,
    `<p class="err">${code}</p><h1>${escapeHtml(title)}</h1>
<p class="sub">${detail}</p>
<footer><a href="/" style="color:#7f868d">&larr; back to the hub</a></footer>`
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
