// The one button every tLib-derived NUI surface draws, shared so that a panel
// mounted inside another resource's editor is the same object as the one in a
// tLib dialog rather than a look-alike.
//
// It lives here and not in tLib's own `components/ui/nui-field.tsx` because the
// marketplace components next door are imported by tELS, tDetector and tRadar,
// and nothing in tLib's app is reachable from a sibling resource — each one is
// a separate FiveM resource with its own CEF page and its own bundle, so the
// only sharing that exists is at build time through this package.
// `nui-field.tsx` re-exports this, so tLib's own 11 import sites are unchanged.
//
// Deliberately self-contained, matching `admin-ui/index.tsx`: solid-js is the
// only code import. No icon set (the three consumers have unplugin-icons but
// not `lucide-solid`), no app-local dialog model, no theme store.
//
// It pulls in `nui.css` itself rather than asking the host to remember, which
// is what `nui-field.tsx` did before the move. Every token in that file carries
// a fallback, so this renders in a host that defines no theme tokens at all —
// tDetector and tRadar are both such hosts today.

import { type JSX, splitProps } from "solid-js";
import "./nui.css";

export function NuiButton(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "destructive" | "default";
  }
) {
  const [local, rest] = splitProps(props, ["tone", "class", "type"]);
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      data-tone={local.tone ?? "default"}
      class={`tlib-nui-control tlib-nui-button ${local.class ?? ""}`}
    />
  );
}
