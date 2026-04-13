// dark-themed settings panel components (used by tRadio, tELS, etc.)

import { type JSX, type ParentProps, Show } from "solid-js";

const C = {
  bg: "hsl(225 8% 12%)",
  card: "hsl(225 8% 16%)",
  border: "hsl(225 10% 30% / 0.6)",
  fg: "hsl(220 10% 90%)",
  muted: "hsl(220 8% 58%)",
  mutedFaint: "hsl(220 8% 58% / 0.5)",
  mutedFainter: "hsl(220 8% 58% / 0.35)",
  accent: "hsl(211 80% 55%)",
  accentFg: "hsl(0 0% 100%)",
  secondary: "hsl(225 10% 26% / 0.6)",
  secondaryHover: "hsl(225 10% 26%)",
  destructive: "hsl(0 62% 50%)",
  destructiveHover: "hsl(0 62% 60%)",
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
            "box-shadow": "0 4px 24px rgba(0,0,0,0.3)",
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
