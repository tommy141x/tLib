// dark-themed settings panel components (used by tRadio, tELS, etc.)

import type { JSX } from "@solidjs/web";
import { type ParentProps, Show } from "solid-js";

/**
 * The palette these controls draw with — the HOST's theme tokens, not a copy.
 *
 * ── What these used to be ───────────────────────────────────────────────────
 *
 * Thirteen hard-coded literals: `hsl(225 8% 12%)`, `hsl(225 8% 16%)`,
 * `hsl(225 10% 30% / 0.6)` and so on. Those are not arbitrary — they are tELS's
 * old blue-tinted palette, frozen into a shared library at some point when tELS
 * was the only consumer. Because every one is applied as an INLINE style, they
 * beat any stylesheet the host has, so a panel built from these controls looked
 * the same everywhere no matter what the surrounding UI was themed to. tLib's
 * own dialogs are neutral grey, so an `AdminPanel` inside tLib was visibly a
 * different product from the dialog containing it.
 *
 * Once tELS moved onto tLib's shared tokens the mismatch simply changed sides:
 * these controls became the only blue things left on a grey screen. A literal in
 * a shared component cannot be right in more than one host, which is the whole
 * argument for reading the token.
 *
 * ── Why each one keeps its old value as a fallback ──────────────────────────
 *
 * `var(--x, <literal>)` is not defensive padding. These controls are exported to
 * any resource that wants a settings panel, and a host that has not defined the
 * token set would otherwise get `hsl()` with an empty argument — an invalid
 * declaration, dropped, leaving a transparent control with `currentColor`
 * borders. The fallback is exactly what that host renders today, so adopting
 * this change can only be a no-op or an improvement for them.
 *
 * ⚠️ No `color-mix()` and no `oklch()` anywhere in here, however tempting for
 * the hover shades: these render in the game's NUI, which is CEF 103, and both
 * landed in Chromium 111. CEF drops the declaration rather than erroring, so the
 * failure would be a silently uncoloured control.
 *
 * ── 2026-09-22: converged onto the --nui-* layer ────────────────────────────
 *
 * Each entry now reads its `--nui-*` equivalent first and keeps the old chain as
 * the fallback, so there is ONE set of names a host overrides to retheme both
 * these controls and the marketplace components in `../marketplace/ui`, rather
 * than two sets that drift. The fallback chain means a host that defines nothing
 * — tDetector and tRadar declare no tokens at all — renders exactly what it
 * rendered before.
 *
 * ⚠️ Two colours DID change on purpose, and this is the repaint that was signed
 * off rather than an accident:
 *
 *   accent       --primary (blue 211 80% 55%) → --nui-accent (neutral #eeeeee)
 *   destructive  --destructive (0 62% 50%)    → --nui-danger (#ff8585)
 *
 * Every consumer rendered the blue: tELS, tDetector and tRadar define no
 * `--primary` and so took the fallback, and tRadio declares that same blue. The
 * accent is now neutral by default and follows a theme's registered primary when
 * there is one, which is what `applyNuiTheme` in tLib's `nui-theme.ts` already
 * intends for every other control — and it resolves the complaint at the top of
 * this comment, where these were "the only blue things left on a grey screen".
 */
const C = {
  bg: "var(--nui-bg, hsl(var(--background, 225 8% 12%)))",
  card: "var(--nui-surface, hsl(var(--card, 225 8% 16%)))",
  border: "hsl(var(--nui-border-raw, var(--border, 225 10% 30%)) / 0.6)",
  fg: "var(--nui-text, hsl(var(--foreground, 220 10% 90%)))",
  muted: "var(--nui-muted, hsl(var(--muted-foreground, 220 8% 58%)))",
  mutedFaint: "hsl(var(--nui-muted-raw, var(--muted-foreground, 220 8% 58%)) / 0.5)",
  mutedFainter: "hsl(var(--nui-muted-raw, var(--muted-foreground, 220 8% 58%)) / 0.35)",
  accent: "var(--nui-accent, #eeeeee)",
  accentFg: "var(--nui-accent-text, #111111)",
  secondary: "hsl(var(--nui-hover-raw, var(--secondary, 225 10% 26%)) / 0.6)",
  secondaryHover: "hsl(var(--nui-hover-raw, var(--secondary, 225 10% 26%)))",
  destructive: "var(--nui-danger, hsl(var(--destructive, 0 62% 50%)))",
  destructiveHover: "var(--nui-danger-hover, hsl(var(--destructive-hover, 0 62% 60%)))",
} as const;

export function SectionLabel(props: { label: string }) {
  return (
    <span
      style={{
        "font-size": "10px",
        "font-family": "monospace",
        color: C.muted,
        "text-transform": "uppercase",
        "letter-spacing": "0.05em",
        "font-weight": "600",
      }}
    >
      {props.label}
    </span>
  );
}

export function Sep() {
  return <div style={{ height: "1px", background: C.border }} />;
}

export function AdminToggle(props: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  onLabel?: string;
  offLabel?: string;
}) {
  const btnBase: JSX.CSSProperties = {
    padding: "2px 10px",
    "font-size": "9px",
    "font-family": "monospace",
    "border-radius": "4px",
    border: "none",
    cursor: "pointer",
    transition: "background 0.15s, color 0.15s",
  };

  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", "flex-direction": "column" }}>
        <span style={{ "font-size": "11px", "font-family": "monospace", color: C.fg }}>
          {props.label}
        </span>
        <Show when={props.description}>
          <span style={{ "font-size": "9px", "font-family": "monospace", color: C.mutedFaint }}>
            {props.description}
          </span>
        </Show>
      </div>
      <div style={{ display: "flex", gap: "4px" }}>
        <button
          style={{
            ...btnBase,
            background: props.value ? C.accent : C.secondary,
            color: props.value ? C.accentFg : C.muted,
          }}
          onClick={() => props.onChange(true)}
        >
          {props.onLabel ?? "On"}
        </button>
        <button
          style={{
            ...btnBase,
            background: !props.value ? C.accent : C.secondary,
            color: !props.value ? C.accentFg : C.muted,
          }}
          onClick={() => props.onChange(false)}
        >
          {props.offLabel ?? "Off"}
        </button>
      </div>
    </div>
  );
}

export function AdminSlider(props: {
  label: string;
  description?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const step = () => props.step ?? 1;
  const display = () =>
    Number.isInteger(props.value) ? String(props.value) : props.value.toFixed(2);

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
        <div style={{ display: "flex", "flex-direction": "column" }}>
          <span style={{ "font-size": "11px", "font-family": "monospace", color: C.fg }}>
            {props.label}
          </span>
          <Show when={props.description}>
            <span style={{ "font-size": "9px", "font-family": "monospace", color: C.mutedFaint }}>
              {props.description}
            </span>
          </Show>
        </div>
        <span
          style={{
            "font-size": "11px",
            "font-family": "monospace",
            color: C.accent,
            "font-variant-numeric": "tabular-nums",
          }}
        >
          {display()}
          {props.unit ?? ""}
        </span>
      </div>
      <input
        type="range"
        class="settings-range"
        min={min()}
        max={max()}
        step={step()}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}

export function AdminButton(props: {
  label: string;
  variant?: "default" | "destructive";
  onClick: () => void;
}) {
  const isDestructive = () => props.variant === "destructive";

  return (
    <button
      style={{
        padding: "6px 10px",
        "font-size": "9px",
        "font-family": "monospace",
        "border-radius": "4px",
        border: "none",
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s",
        background: isDestructive() ? C.destructive : C.secondary,
        color: isDestructive() ? C.accentFg : C.muted,
      }}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

export function AdminPanel(
  props: ParentProps<{
    title: string;
    icon?: JSX.Element;
    width?: string;
    onClose: () => void;
  }>
) {
  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "9999",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          "font-family": "Inter, sans-serif",
          "font-size": "12px",
          color: C.fg,
          "user-select": "none",
          "-webkit-user-select": "none",
          "pointer-events": "auto",
        }}
      >
        <div
          style={{
            width: props.width ?? "420px",
            "max-height": "85vh",
            display: "flex",
            "flex-direction": "column",
            overflow: "hidden",
            background: C.card,
            border: `1px solid ${C.border}`,
            "border-radius": "8px",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              padding: "10px 16px",
              "border-bottom": `1px solid ${C.border}`,
            }}
          >
            <span
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                "font-size": "11px",
                "font-family": "monospace",
                "font-weight": "600",
                color: C.accent,
              }}
            >
              {props.icon}
              {props.title}
            </span>
            <button
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                width: "24px",
                height: "24px",
                "border-radius": "4px",
                border: "none",
                cursor: "pointer",
                background: "transparent",
                color: C.muted,
                transition: "background 0.15s, color 0.15s",
              }}
              onClick={props.onClose}
            >
              ✕
            </button>
          </div>

          {/* Body (scrollable) */}
          <div
            class="settings-scroll"
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "20px",
              padding: "16px",
              "overflow-y": "auto",
            }}
          >
            {props.children}
          </div>
        </div>
      </div>
    </div>
  );
}

export { C as AdminColors };
