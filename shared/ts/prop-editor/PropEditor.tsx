/**
 * PropEditor — the full-screen 3D gizmo overlay for positioning a vehicle prop.
 *
 * Layout:
 *   - Left toolbar:  Move / Rotate / Space / Driver POV / WASD camera
 *   - Top-centre:    vehicle badge
 *   - Top-right:     optional host slot + Save + Cancel
 *   - Right panel:   X/Y/Z/RX/RY/RZ + Remove
 *   - Bottom:        keyboard hint bar
 *
 * ── What a host supplies ────────────────────────────────────────────────────
 *
 * `prefix` and nothing else, at minimum. Everything the editor sends and
 * listens for is `<prefix>:…`, matching `tlib.propeditor.create{ prefix = … }`
 * on the Lua side; the two prefixes ARE the contract between the halves, and a
 * mismatch is silent — the page renders and no button does anything.
 *
 * ── What this does not know ─────────────────────────────────────────────────
 *
 * Which prop model is being edited, how placements are keyed, what a vehicle is
 * called in any particular data file, and anything at all about Discovery or
 * config export. The last of those is `slots.toolbar`.
 */

import { Button } from "@tlib/shared/ui/button";
import { createSignal, For, onSettled, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "../nui";
import { Separator } from "../ui/separator";
import "./prop-editor.css";
import { cameraCommandFor, getNumpadKey, KEY_COMMANDS } from "./numpad";
import { PanelHover, PropField } from "./parts";
import { PropEditorViewport } from "./PropEditorViewport";
import { getGizmoScene } from "./scene";
import { makePropEditorTranslator } from "./strings";
import {
  closePropEditor,
  openPropEditor,
  propEditorState,
  setPropEditorMode,
  setPropEditorPropData,
  togglePropEditorSpace,
} from "./store";
import type {
  PropEditorFeatures,
  PropEditorInitMessage,
  PropEditorSlots,
  PropEditorTranslate,
} from "./types";

export interface PropEditorProps {
  /** Event namespace, without the colon. Must match the Lua descriptor. */
  prefix: string;
  /**
   * A class wrapping the whole overlay, for a host that scopes its CSS custom
   * properties to a root (`.radio-settings-root`). Omit it and the editor
   * inherits whatever tokens are in scope at the mount point.
   */
  scopeClass?: string;
  /** Falls back to the English defaults in `strings.ts` for anything unhandled. */
  t?: PropEditorTranslate;
  features?: PropEditorFeatures;
  slots?: PropEditorSlots;
  /** Fired after the init message has been applied, and after close. */
  onOpen?: (data: PropEditorInitMessage) => void;
  onClose?: () => void;
}

/**
 * The card surface every panel of this editor sits on.
 *
 * ── Why this is a constant, and why it carries a shadow ─────────────────────
 *
 * Each panel used to spell out `bg-card/90 border border-border/40 rounded` for
 * itself, and they drifted: `border-border/40` over `--card` is a 4-point step
 * in luminance on tRadio's palette (rgba(69,73,84,.4) composited on rgb(38,39,44)
 * is rgb(50,53,60)), so the "border" was invisible and the panels read as flat
 * rectangles floating on the game rather than as raised surfaces. tLib's own card
 * — `.settings-panel`, and `ui/card.tsx` — has always carried a drop shadow; this
 * editor was the one surface in the stack without one.
 *
 * The shadow is spelled out rather than `shadow-lg` on purpose: wind3's `shadow-*`
 * scale is built for a page with an opaque background, and its 10%-black default
 * is invisible over a TRANSPARENT NUI composited on the game. The value here is
 * the one `.settings-panel` uses.
 */
const PANEL_SURFACE = "bg-card/95 border border-border/60 shadow-[0_4px_24px_rgba(0,0,0,0.45)]";

/**
 * Sizes live in `prop-editor.css`, colours live here.
 *
 * Every panel and control below pairs a token-utility string (this file) with a
 * geometry class (the stylesheet). The split is not cosmetic: the arbitrary font
 * sizes that used to be in these constants collided with the text COLOUR beside
 * them inside `cn`, which drops one of the pair silently — that shipped a POV
 * button rendering at the page's 16px next to four 9px siblings. There is now no
 * arbitrary font size anywhere in this file, so the collision has no way to
 * recur, and the sizes it used to hard-code scale with the viewport instead.
 *
 * The contrast decisions those constants carried are unchanged and deliberate:
 * a panel keeps a visible border and a real drop shadow so it reads as a raised
 * surface over the game rather than a flat rectangle, and no label is faded with
 * an opacity modifier — `text-muted-foreground/50` measured 2.2:1 and
 * photographed as a blank strip.
 */
/** A hint pair. No size of its own — it inherits the hint bar's. */
const HINT = "font-mono text-muted-foreground";
/** A section heading. `uppercase tracking-wide` is what separates it from the axis labels. */
const SECTION_LABEL = "font-mono text-muted-foreground uppercase tracking-wide tlib-pe-label";

/**
 * The idle and lit variants of every toggle in the left toolbar.
 *
 * The toolbar used to hand-roll both states as class strings. They are now the
 * shared button kit's own variants, which is what the save/cancel pair in tELS
 * uses and what this editor was asked to look like: a real hover step, a
 * `data-[pressed]` state and a `focus-visible` ring, none of which the
 * hand-rolled versions had.
 *
 * Idle is `secondary` and NOT `ghost`. Ghost is transparent, and an unlit
 * toolbar button with no fill at all does not read as a button against the
 * toolbar's own card fill — that was the finding behind the filled idle state
 * these replace, and it still holds.
 */
const toolVariant = (active: boolean) => (active ? "default" : "secondary");

export function PropEditor(props: PropEditorProps) {
  const [wasdCamMode, setWasdCamMode] = createSignal(false);
  const T = makePropEditorTranslator(props.t);

  const nui = (name: string, data: unknown = {}) => fetchNui(`${props.prefix}:${name}`, data);
  const cam = (cmd: string) => nui("propEditorCameraCmd", { cmd });
  const hover = (hovered: boolean) => nui("propEditorPanelHover", { hovered });

  // The Lua half drives open/close; the host wires nothing.
  //
  // `onSettled` is Solid 2's `onMount`, and the cleanup is RETURNED — it refuses
  // a nested `onCleanup` outright ([CLEANUP_IN_FORBIDDEN_SCOPE]). An effect can
  // only return one cleanup, so the two unsubscribes are composed into it.
  onSettled(() => {
    const offInit = onNuiEvent<PropEditorInitMessage>(`${props.prefix}:propEditorInit`, (data) => {
      openPropEditor(data);
      props.onOpen?.(data);
    });
    const offClose = onNuiEvent(`${props.prefix}:propEditorClose`, () => {
      closePropEditor();
      props.onClose?.();
    });
    return () => {
      offInit();
      offClose();
    };
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (!propEditorState.open) return;
    // Numeric fields must still receive plain typing, and the top-row numpad
    // emulation below would otherwise eat every digit.
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;

    const nk = getNumpadKey(e);
    if (nk !== null) {
      e.preventDefault();
      const cmd = cameraCommandFor(nk, e.ctrlKey);
      if (cmd) cam(cmd);
      return;
    }

    const viewCmd = KEY_COMMANDS[e.code];
    if (viewCmd) {
      e.preventDefault();
      cam(viewCmd);
      return;
    }

    if (e.code === "Escape") {
      e.preventDefault();
      nui("propEditorCancel");
      return;
    }

    // Editor shortcuts are gated off in WASD cam mode — Lua reads WASD per-frame
    // there, and W would otherwise also switch the gizmo to translate.
    if (!wasdCamMode()) {
      if (e.code === "KeyW") setPropEditorMode("translate");
      else if (e.code === "KeyR") setPropEditorMode("rotate");
      else if (e.code === "KeyX") togglePropEditorSpace();
    }
  }

  onSettled(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function updatePosition(axis: "x" | "y" | "z", v: number) {
    const pd = { ...propEditorState.propData, [axis]: v };
    setPropEditorPropData(pd);
    nui("propMoved", { x: pd.x, y: pd.y, z: pd.z });
    getGizmoScene()?.updatePropGizmo(pd);
  }

  function updateRotation(axis: "rx" | "ry" | "rz", v: number) {
    const pd = { ...propEditorState.propData, [axis]: v };
    setPropEditorPropData(pd);
    nui("propRotated", { rx: pd.rx, ry: pd.ry, rz: pd.rz });
    getGizmoScene()?.updatePropGizmo(pd);
  }

  const positionAxes = [
    { label: "X", key: "x" },
    { label: "Y", key: "y" },
    { label: "Z", key: "z" },
  ] as const;
  const rotationAxes = [
    { label: "RX", key: "rx" },
    { label: "RY", key: "ry" },
    { label: "RZ", key: "rz" },
  ] as const;

  return (
    <Show when={propEditorState.open}>
      {/* `data-prop-editor` is the editor's only host-independent anchor. The
          wrapper's CLASS is the host's (`.radio-settings-root` in tRadio, nothing
          at all in tRadar and tDetector, whose tokens are on `:root`), so a tool
          that has to find this editor in a page — the shared gallery does, and so
          would any browser test — cannot key on it. */}
      <div class={props.scopeClass} data-prop-editor="">
        <PropEditorViewport prefix={props.prefix} />

        {/* Overlay. pointer-events-none so the canvas below still receives the
            drags that orbit the camera; each panel opts back in. */}
        <div class="fixed inset-0 z-10 pointer-events-none">
          {/* ── Top-centre: vehicle badge ── */}
          <PanelHover
            onHoverChange={hover}
            class={`absolute tlib-pe-badge ${PANEL_SURFACE} border-t-0 pointer-events-auto`}
          >
            <span class="font-mono text-foreground font-semibold">
              {propEditorState.vehicleDisplayName}
            </span>
            {/* Full token, not `/60`: this is the only thing on screen naming
                which editor is open, and faded it was unreadable. */}
            <span class="font-mono text-muted-foreground tlib-pe-badge-suffix">
              {T("title_suffix")}
            </span>
          </PanelHover>

          {/* ── Top-right: host slot + Save + Cancel ── */}
          {/* The two actions are the shared button kit at its `default` and
              `secondary` variants — primary fill for the affirmative one, a muted
              fill for the one that throws the edit away. That is the pairing tELS
              ships and the one this editor was asked to match. */}
          <PanelHover
            onHoverChange={hover}
            class="absolute tlib-pe-actions z-30 flex items-start pointer-events-auto"
          >
            <Show when={props.features?.toolbarSlot && props.slots?.toolbar}>
              {props.slots?.toolbar}
            </Show>
            <Button
              data-prop-editor-save=""
              class="tlib-pe-btn font-mono font-semibold"
              onClick={() => nui("propEditorSave")}
            >
              {T("btn_save")}
            </Button>
            <Button
              data-prop-editor-cancel=""
              variant="secondary"
              class="tlib-pe-btn font-mono font-semibold"
              onClick={() => nui("propEditorCancel")}
            >
              {T("btn_cancel")}
            </Button>
          </PanelHover>

          {/* ── Left toolbar ── */}
          <PanelHover
            onHoverChange={hover}
            class={`absolute tlib-pe-toolbar ${PANEL_SURFACE} flex flex-col pointer-events-auto`}
          >
            {/* `data-tool` / `data-active` on every button in this toolbar: the
                captions are locale strings in one host and English defaults in
                the others, so glyph-matching finds nothing under a translation.
                These are the semantic handle, and they are passed explicitly
                rather than left to Ark's own `data-pressed` — a gallery and a
                browser test key on `data-active`, which is this editor's
                vocabulary and not the toggle primitive's. */}
            <Button
              toggle
              data-tool="move"
              data-active={propEditorState.mode === "translate" ? "" : undefined}
              title={T("btn_move_title")}
              variant={toolVariant(propEditorState.mode === "translate")}
              pressed={propEditorState.mode === "translate"}
              onPressedChange={() => setPropEditorMode("translate")}
              class="tlib-pe-tool font-mono font-semibold"
            >
              W
            </Button>
            <Button
              toggle
              data-tool="rotate"
              data-active={propEditorState.mode === "rotate" ? "" : undefined}
              title={T("btn_rotate_title")}
              variant={toolVariant(propEditorState.mode === "rotate")}
              pressed={propEditorState.mode === "rotate"}
              onPressedChange={() => setPropEditorMode("rotate")}
              class="tlib-pe-tool font-mono font-semibold"
            >
              R
            </Button>

            <Separator class="bg-border/60 tlib-pe-sep" />

            <Button
              toggle
              data-tool="space"
              data-space={propEditorState.space}
              data-active={propEditorState.space === "local" ? "" : undefined}
              title={T("btn_space_title_format").replace("{space}", propEditorState.space)}
              variant={toolVariant(propEditorState.space === "local")}
              pressed={propEditorState.space === "local"}
              onPressedChange={() => togglePropEditorSpace()}
              class="tlib-pe-tool font-mono font-semibold"
            >
              {propEditorState.space === "local" ? T("coord_local") : T("coord_world")}
            </Button>

            <Separator class="bg-border/60 tlib-pe-sep" />

            {/* POV is a momentary action, not a state — it snaps the camera once
                — so it is the one control here that is not a toggle. It takes the
                idle variant permanently, which is also what keeps it looking like
                the four toggles beside it when none of them is lit. */}
            <Button
              data-tool="pov"
              title={T("btn_pov_title")}
              variant="secondary"
              class="tlib-pe-tool font-mono font-semibold"
              onClick={() => cam("viewDriverPov")}
            >
              {T("btn_pov")}
            </Button>

            <Button
              toggle
              data-tool="cam"
              data-active={wasdCamMode() ? "" : undefined}
              title={wasdCamMode() ? T("wasd_cam_on") : T("wasd_cam_off")}
              variant={toolVariant(wasdCamMode())}
              pressed={wasdCamMode()}
              onPressedChange={() => {
                const next = !wasdCamMode();
                setWasdCamMode(next);
                nui("setCamMode", { enabled: next });
              }}
              class="tlib-pe-tool font-mono font-semibold"
            >
              {T("btn_cam")}
            </Button>
          </PanelHover>

          {/* ── Right: properties ── */}
          <PanelHover
            onHoverChange={hover}
            class="absolute tlib-pe-props flex flex-col pointer-events-auto overflow-y-auto"
          >
            <div class={`${PANEL_SURFACE} tlib-pe-props-card flex flex-col`}>
              <span class={SECTION_LABEL}>{T("section_position")}</span>
              <For each={positionAxes}>
                {(axis) => (
                  <PropField
                    label={axis.label}
                    value={propEditorState.propData[axis.key]}
                    onChange={(v) => updatePosition(axis.key, v)}
                  />
                )}
              </For>

              <Separator class="bg-border/60 tlib-pe-sep" />

              <span class={SECTION_LABEL}>{T("section_rotation")}</span>
              <For each={rotationAxes}>
                {(axis) => (
                  <PropField
                    label={axis.label}
                    value={propEditorState.propData[axis.key]}
                    onChange={(v) => updateRotation(axis.key, v)}
                  />
                )}
              </For>
            </div>

            {/* The kit's `destructive` variant rather than the hand-mixed
                `bg-destructive/20` wash this used to carry: that wash composited
                to a barely-tinted panel over the game, and it had neither a
                perceptible hover step nor a focus ring. The drop shadow is kept
                because this button floats free of any panel. */}
            <Button
              data-prop-editor-remove=""
              variant="destructive"
              class="tlib-pe-remove font-mono font-semibold shadow-[0_4px_24px_rgba(0,0,0,0.45)]"
              onClick={() => nui("propEditorRemove")}
            >
              {T("btn_remove_prop")}
            </Button>
          </PanelHover>

          {/* ── Bottom hint bar ── */}
          <PanelHover
            onHoverChange={hover}
            class={`absolute tlib-pe-hints ${PANEL_SURFACE} flex items-center pointer-events-auto`}
          >
            <span class={HINT}>
              <span class="text-foreground">{T("hint_mmb_orbit")}</span> {T("hint_orbit_label")}
            </span>
            <span class={HINT}>
              <span class="text-foreground">{T("hint_shift_mmb")}</span> {T("hint_pan_label")}
            </span>
            <span class={HINT}>
              <span class="text-foreground">{T("hint_scroll")}</span> {T("hint_zoom_label")}
            </span>
            <Separator orientation="vertical" class="tlib-pe-sep-v bg-border/60" />
            <Show when={wasdCamMode()}>
              <span class={HINT}>
                <span class="text-foreground">{T("hint_wasd")}</span> {T("hint_wasd_orbit_label")}
              </span>
              <span class={HINT}>
                <span class="text-foreground">{T("hint_qe")}</span> {T("hint_qe_zoom_label")}
              </span>
            </Show>
            <Show when={!wasdCamMode()}>
              <span class={HINT}>
                <span class="text-foreground">{T("hint_w_key")}</span> {T("hint_w_label")}
              </span>
              <span class={HINT}>
                <span class="text-foreground">{T("hint_r_key")}</span> {T("hint_r_label")}
              </span>
              <span class={HINT}>
                <span class="text-foreground">{T("hint_x_key")}</span> {T("hint_x_label")}
              </span>
            </Show>
            <span class={HINT}>
              <span class="text-foreground">{T("hint_p_key")}</span> {T("hint_p_label")}
            </span>
            <span class={HINT}>
              <span class="text-foreground">{T("hint_esc_key")}</span> {T("hint_esc_label")}
            </span>
          </PanelHover>
        </div>
      </div>
    </Show>
  );
}

export default PropEditor;
