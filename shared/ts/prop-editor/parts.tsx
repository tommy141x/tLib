/**
 * The two chrome primitives the prop editor is built from.
 *
 * Colours are shared TOKEN NAMES (`bg-card`, `border-border`, `text-foreground`,
 * `bg-input`) rather than literal values, so a consumer's own token set themes
 * the editor with no override here. UnoCSS wind3 — NUI is CEF 103, where wind4's
 * `oklch()` and `color-mix()` are dropped silently rather than erroring.
 */

import type { JSX } from "@solidjs/web";
import { cn } from "../cn";

export interface PropFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
}

/**
 * One numeric axis. `onChange`, not `onInput`: committing per keystroke would
 * fire a NUI callback for every digit typed, and "0.0" is a legal prefix of
 * "0.05" that would teleport the prop to the origin on the way there.
 */
export function PropField(props: PropFieldProps) {
  return (
    <div class="flex items-center tlib-pe-field">
      <span class="font-mono text-muted-foreground text-right shrink-0 tlib-pe-field-label">
        {props.label}
      </span>
      {/* Sizes, the hover step and the focus ring are all in `prop-editor.css`,
          which is also where the ring is matched to the shared button kit's —
          same token, same width, same offset. The old `focus:outline-none` with
          only a border tint left this the one control in the editor a keyboard
          user could not see they were on. */}
      <input
        type="number"
        step="0.001"
        class="flex-1 w-0 font-mono bg-input text-foreground border border-border/50 tlib-pe-field-input"
        value={props.value.toFixed(4)}
        onChange={(e) => {
          const v = Number.parseFloat(e.currentTarget.value);
          if (!Number.isNaN(v)) props.onChange(v);
        }}
      />
    </div>
  );
}

export interface PanelHoverProps {
  class?: string;
  /** Called with true on enter, false on leave. */
  onHoverChange: (hovered: boolean) => void;
  children?: JSX.Element;
}

/**
 * A panel that tells the game when the pointer is over it.
 *
 * The Lua half suppresses scroll-wheel dolly while this is true. Without it,
 * scrolling the properties list also zooms the camera, because the wheel reaches
 * both the page and the game.
 */
export function PanelHover(props: PanelHoverProps) {
  return (
    // Hover-detection wrapper, not an interactive control: the panel's own
    // buttons are the interactive parts.
    <div
      class={cn(props.class)}
      onMouseEnter={() => props.onHoverChange(true)}
      onMouseLeave={() => props.onHoverChange(false)}
    >
      {props.children}
    </div>
  );
}
