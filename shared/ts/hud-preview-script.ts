// The binder, as a self-contained script string, for a preview document that
// cannot import anything.
//
// ── Why this exists at all, given HudBinder is right next door ──────────────
//
// The in-game marketplace preview renders a fetched layout in
// `<iframe srcdoc sandbox="allow-scripts">`. Without `allow-same-origin` that
// frame is an OPAQUE origin: it shares no realm with the NUI bundle, cannot be
// reached into from outside, and cannot fetch our chunks back — they are
// cross-origin to it even though they sit on the same server. So the binder has
// to arrive as text, inside the document. That constraint is real and this file
// does not argue with it.
//
// ── What this file fixes ────────────────────────────────────────────────────
//
// It used to live inline in `PreviewOverlay.tsx` as a second, smaller binder
// that handled five of the nine attributes and looked every key up FLAT —
// `s[key]`, no dot paths. Measured against the shipped layouts that blanked 56%
// of tRadar's bindings and 11% of tRadio's: the preview showed a device with
// empty readouts while the same markup worked perfectly in game, which reads to
// a skin author as a broken skin rather than a broken preview.
//
// Keeping it beside `hud-template.ts` is not decoration. `hud-preview-script`'s
// test renders the SAME markup and state through both this script and a real
// `HudBinder` and compares the resulting DOM, so a grammar added to one and not
// the other is a failing test rather than a silent divergence.
//
// ⚠️ `data-hud-btn` is deliberately NOT implemented. A preview is a still: there
// is no engine behind it to act on a press, and wiring a click that does nothing
// is worse than a button that plainly is not live.

import { HUD_BINDING_ATTRS } from "./hud-template";

/**
 * Attributes the preview paints. Everything in the grammar except `data-hud-btn`,
 * derived from the grammar rather than restated, so adding one there surfaces here.
 */
export const HUD_PREVIEW_ATTRS = HUD_BINDING_ATTRS.filter((a) => a !== "data-hud-btn");

/**
 * The raw JS. Exported separately from the `<script>` wrapper so a test can run
 * it with `new Function(...)` instead of asserting about a string.
 *
 * @param fn   Name of a layout's own global update function, called INSTEAD of the
 *             declarative pass when it exists. tELS's WCC2 and anything built
 *             before the binder ship one; it may register asynchronously, hence
 *             the retry.
 * @param state The dummy state to paint, already the nested shape the runtime sends.
 */
export function hudPreviewScriptSource(
  fn: string | null | undefined,
  state: Record<string, unknown>
): string {
  const s = JSON.stringify(state);
  const named = fn ? JSON.stringify(fn) : "null";
  // Plain ES5-flavoured code on purpose: it is injected into a customer document
  // that we do not compile, and the NUI is Chrome 103.
  return `(function(){
var STATE=${s},FN=${named},tries=0;
function read(key){
  if(key.indexOf('.')<0)return STATE[key];
  var parts=key.split('.'),obj=STATE;
  for(var i=0;i<parts.length;i++){
    if(obj==null||typeof obj!=='object')return undefined;
    obj=obj[parts[i]];
  }
  return obj;
}
function each(attr,visit){
  var els=document.querySelectorAll('['+attr+']');
  for(var i=0;i<els.length;i++){
    var raw=els[i].getAttribute(attr);
    if(raw===null)continue;
    visit(els[i],raw);
  }
}
function split(raw){
  var c=raw.indexOf(':');
  return c<0?null:{key:raw.slice(0,c),rest:raw.slice(c+1)};
}
function bind(){
  each('data-hud-text',function(el,k){var v=read(k);el.textContent=v==null?'':String(v);});
  each('data-hud-html',function(el,k){var v=read(k);el.innerHTML=v==null?'':String(v);});
  each('data-hud-led',function(el,k){el.classList.toggle('active',!!read(k));});
  each('data-hud-show',function(el,k){el.style.display=read(k)?'':'none';});
  each('data-hud-hide',function(el,k){el.style.display=read(k)?'none':'';});
  each('data-hud-led-color',function(el,k){
    var v=read(k);
    el.style.backgroundColor=(v&&v.r!=null)?('rgba('+v.r+', '+v.g+', '+v.b+', '+(v.a==null?1:v.a)+')'):'';
  });
  each('data-hud-eq',function(el,raw){
    var p=split(raw);
    if(!p)return;
    el.classList.toggle('active',String(read(p.key))===p.rest);
  });
  each('data-hud-attr',function(el,raw){
    var p=split(raw);
    if(!p||!p.key||!p.rest)return;
    var v=read(p.key);
    if(v!=null&&v!==''&&v!==false)el.setAttribute(p.rest,String(v));
    else el.removeAttribute(p.rest);
  });
  if(STATE.theme!==undefined&&document.body)
    document.body.classList.toggle('theme-dark',STATE.theme==='Dark');
}
function run(){
  if(FN&&typeof window[FN]==='function'){window[FN](STATE,document.body);return;}
  if(FN&&++tries<40){setTimeout(run,100);return;}
  bind();
}
// ⚠️ Only the named-function path waits. The script is injected at the end of
// <body>, so every element it binds already exists, and a purely declarative
// layout has nothing to wait FOR — the delay used to be unconditional, which is
// fine for a live preview and wrong for a headless screenshot run, where the
// capture can land before a deferred timer ever fires and the shot comes out
// blank. Painting synchronously also gets the preview to its first frame sooner.
if(FN)setTimeout(run,50);else bind();
})()`;
}

/** The same source, wrapped for injection into a document's markup. */
export function buildHudPreviewScript(
  fn: string | null | undefined,
  state: Record<string, unknown>
): string {
  return `<script>${hudPreviewScriptSource(fn, state)}</script>`;
}
