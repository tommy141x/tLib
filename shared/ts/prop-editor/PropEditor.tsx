/**
 * PropEditor — the full-screen 3D gizmo overlay for positioning a vehicle prop.
 *
 * A host supplies `prefix` and nothing else, at minimum: everything sent and
 * listened for is `<prefix>:…`, matching `tlib.propeditor.create{ prefix = … }`.
 * The two prefixes ARE the contract between the halves, and a mismatch is
 * silent -- the page renders and no button does anything.
 *
 * Design notes: docs/internal/prop-editor-ui.md
 */

import { FocusTrap } from "@ark-ui/solid/focus-trap";
import { createEscapeLayer } from "@tlib/shared/escape-layer";
import { Button } from "@tlib/shared/ui/button";
import { ConfirmDelete } from "@tlib/shared/ui/confirm-delete";
import { UndoHint, UndoRedo } from "@tlib/shared/ui/undo-redo";
import { UndoHistory } from "@tlib/shared/undo";
import { createUndoScope } from "@tlib/shared/undo-keys";
import { createSignal, For, onSettled, Show } from "solid-js";
import { clampUniformScale } from "../gizmo/types";
import { fetchNui, onNuiEvent } from "../nui";
import { Separator } from "../ui/separator";
import "./prop-editor.css";
import { cameraCommandFor, getNumpadKey, KEY_COMMANDS } from "./numpad";
import { PropEditorViewport } from "./PropEditorViewport";
import { PanelHover, PropField } from "./parts";
import { getGizmoScene } from "./scene";
import {
  closePropEditor,
  openPropEditor,
  propEditorState,
  propEditorTransform,
  setPropEditorMode,
  setPropEditorPropData,
  togglePropEditorSpace,
} from "./store";
import { makePropEditorTranslator } from "./strings";
import type {
  PropData,
  PropEditorFeatures,
  PropEditorInitMessage,
  PropEditorSlots,
  PropEditorTranslate,
} from "./types";
import {
  fieldUndoLabel,
  PROP_TRANSFORM_TAG,
  propTransformUndoable,
  transformMessages,
} from "./undo";

export interface PropEditorProps {
  /** Event namespace, without the colon. Must match the Lua descriptor. */
  prefix: string;
  /** A class wrapping the whole overlay, for a host that scopes its tokens to a
   *  root. Omit it and the editor inherits whatever is in scope at the mount. */
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
 * The card surface every panel of this editor sits on. Opaque fill, full-strength
 * border, no compositor effect: CEF does not composite one usefully over a moving
 * 3D scene, and a 40%-alpha border over `--card` is a 4-point luminance step --
 * invisible, which is why the panels read as flat rectangles before this.
 */
const PANEL_SURFACE = "bg-card border border-border";

/**
 * Sizes live in `prop-editor.css`, colours live here. The split is not cosmetic:
 * an arbitrary font size collides with the text COLOUR beside it inside `cn`,
 * which drops one of the pair silently -- that shipped a POV button at 16px next
 * to four 9px siblings. No label is faded with an opacity modifier either;
 * `text-muted-foreground/50` measured 2.2:1 and photographed as a blank strip.
 */
/** A hint pair. No size of its own — it inherits the hint bar's. */
const HINT = "font-mono text-muted-foreground";
/** A section heading. `uppercase tracking-wide` is what separates it from the axis labels. */
const SECTION_LABEL = "font-mono text-muted-foreground uppercase tracking-wide tlib-pe-label";

/**
 * The idle and lit variants of every toggle in the left toolbar. Idle is
 * `secondary` and NOT `ghost`: a transparent control over the toolbar's own card
 * fill does not read as a button.
 */
const toolVariant = (active: boolean) => (active ? "default" : "secondary");

export function PropEditor(props: PropEditorProps) {
  const [wasdCamMode, setWasdCamMode] = createSignal(false);
  /**
   * Whether the discard question is up. See `requestCancel`.
   */
  const [discarding, setDiscarding] = createSignal(false);
  const T = makePropEditorTranslator(props.t);

  const nui = (name: string, data: unknown = {}) => fetchNui(`${props.prefix}:${name}`, data);
  const cam = (cmd: string) => nui("propEditorCameraCmd", { cmd });
  const hover = (hovered: boolean) => nui("propEditorPanelHover", { hovered });

  /**
   * ONE INSTANCE, OWNED BY THIS COMPONENT, not a module singleton. tRadio's
   * settings app hosts this editor inside itself, and a shared stack would let
   * one Ctrl+Z walk the outer app's history and restore state the player cannot
   * see. Nesting is expressed by nesting the objects; arbitration is `depth`.
   */
  const history = new UndoHistory({ label: "prop-editor" });

  /**
   * Put a whole transform back — the store, the game and the gizmo handle. All
   * three channels rather than only what changed: `scale` moves the prop between
   * the attached path and the per-frame `tlib.drivenprop` path, so a partial
   * restore can leave the Lua half re-attaching at the old scale.
   */
  function applyTransform(pd: PropData) {
    setPropEditorPropData(pd);
    for (const [action, data] of transformMessages(pd)) nui(action, data);
    getGizmoScene()?.updatePropGizmo(pd);
  }

  // The Lua half drives open/close; the host wires nothing.
  //
  // `onSettled` is Solid 2's `onMount`, and the cleanup is RETURNED — it refuses
  // a nested `onCleanup` outright ([CLEANUP_IN_FORBIDDEN_SCOPE]). An effect can
  // only return one cleanup, so the unsubscribes are composed into it.
  onSettled(() => {
    // One tag, registered for the component's whole life. Nothing can withdraw a
    // prop's transform mid-session, so unlike the layout editor's per-component
    // tags this is registered once and never re-registered.
    const disposeUndoable = history.register<PropData>(
      PROP_TRANSFORM_TAG,
      propTransformUndoable({ read: propEditorTransform, write: applyTransform })
    );
    const offInit = onNuiEvent<PropEditorInitMessage>(`${props.prefix}:propEditorInit`, (data) => {
      openPropEditor(data);
      // Cleared on OPEN, so a session can never inherit the previous placement's
      // history — an undo that reached back past the open would restore one
      // vehicle's transform onto another's prop, and `isDirty()` would report a
      // brand-new session as already dirty and prompt on a Cancel with nothing
      // to lose.
      history.clear();
      setDiscarding(false);
      props.onOpen?.(data);
    });
    const offClose = onNuiEvent(`${props.prefix}:propEditorClose`, () => {
      closePropEditor();
      history.clear();
      setDiscarding(false);
      props.onClose?.();
    });
    return () => {
      offInit();
      offClose();
      disposeUndoable();
    };
  });

  /*
   * Escape is NOT in here. It is a registered layer -- see `createEscapeLayer`
   * in the `onSettled` below. As a branch of this raw listener it had no
   * `defaultPrevented` check and no `repeat` check, and all three consumers
   * discarded a placement on one unprompted Escape.
   */
  function handleKeyDown(e: KeyboardEvent) {
    if (!propEditorState.open || e.defaultPrevented) return;
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

    // Editor shortcuts are gated off in WASD cam mode — Lua reads WASD per-frame
    // there, and W would otherwise also switch the gizmo to translate.
    if (!wasdCamMode()) {
      if (e.code === "KeyW") setPropEditorMode("translate");
      else if (e.code === "KeyR") setPropEditorMode("rotate");
      // `S` is free: the numpad emulation above claims only digits and
      // `+ - . /`, `KEY_COMMANDS` claims only Home and P, and the WASD camera
      // reads its keys per-frame in Lua while this whole branch is gated off.
      else if (e.code === "KeyS") setPropEditorMode("scale");
      else if (e.code === "KeyX") togglePropEditorSpace();
    }
  }

  /**
   * What Cancel and Escape both go through, so neither can discard silently.
   *
   * `history.isDirty()` IS the dirty flag, and it is the one that was missing: the
   * history is cleared on every init and records every drag and numeric edit, and
   * `canUndo()` includes an OPEN batch, so a drag in progress counts. Gated on
   * dirty, because asking every time is how a prompt gets dismissed unread.
   */
  function requestCancel() {
    if (!propEditorState.open) return;
    if (history.isDirty()) {
      setDiscarding(true);
      return;
    }
    nui("propEditorCancel");
  }

  function discard() {
    setDiscarding(false);
    nui("propEditorCancel");
  }

  onSettled(() => {
    window.addEventListener("keydown", handleKeyDown);
    /*
     * Depth 1, because this editor is mounted OVER a host -- tRadio's settings
     * app, tRadar's, tDetector's -- and while it is open it is the innermost
     * thing on screen. `active` is the host's own open flag, so the closed mount
     * cannot shadow the host it is mounted in.
     *
     * `onInternal` first: while the discard question is up, Escape answers THAT
     * and nothing else, so it can never throw a placement away however many
     * times it is pressed.
     */
    const disposeEscape = createEscapeLayer({
      label: "prop-editor",
      depth: 1,
      active: () => propEditorState.open,
      onInternal: () => {
        if (!discarding()) return false;
        setDiscarding(false);
        return true;
      },
      onEscape: requestCancel,
    });
    /*
     * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, through the shared registry.
     *
     * `depth: 1` IS THE NESTING FIX, against the same host as the Escape layer.
     * `active` stands the scope down while the discard question is up: that
     * dialog is a decision, not an edit surface. `ignoreWhenTyping` stays at its
     * default -- the panel is six number fields, and taking Ctrl+Z from a focused
     * field would leave no way to take back a typo.
     */
    const disposeUndoKeys = createUndoScope({
      label: "prop-editor",
      depth: 1,
      history,
      active: () => propEditorState.open && !discarding(),
    });
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      disposeEscape();
      disposeUndoKeys();
    };
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

  /**
   * One scalar, clamped before it is stored or sent.
   */
  function updateScale(v: number) {
    const pd = { ...propEditorState.propData, scale: clampUniformScale(v) };
    setPropEditorPropData(pd);
    nui("propScaled", { scale: pd.scale });
    getGizmoScene()?.updatePropGizmo(pd);
  }

  /*
   * BATCHING THE NUMERIC FIELDS
   */
  function editPosition(axis: "x" | "y" | "z", label: string, v: number) {
    history.push(fieldUndoLabel(label), [PROP_TRANSFORM_TAG]);
    updatePosition(axis, v);
  }

  function editRotation(axis: "rx" | "ry" | "rz", label: string, v: number) {
    history.push(fieldUndoLabel(label), [PROP_TRANSFORM_TAG]);
    updateRotation(axis, v);
  }

  function editScale(v: number) {
    history.push(fieldUndoLabel("S"), [PROP_TRANSFORM_TAG]);
    updateScale(v);
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
          would any browser test — cannot key on it. */}
      <div class={props.scopeClass} data-prop-editor="">
        <PropEditorViewport prefix={props.prefix} history={history} />

        {/* Overlay. pointer-events-none so the canvas below still receives the
            drags that orbit the camera; each panel opts back in. */}
        <div class="fixed inset-0 z-10 pointer-events-none">
          {/* Top-centre: vehicle badge */}
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

          {/* Top-right: host slot + Save + Cancel */}
          {/* The two actions are the shared button kit at its `default` and
              ships and the one this editor was asked to match. */}
          <PanelHover
            onHoverChange={hover}
            class="absolute tlib-pe-actions z-30 flex items-start pointer-events-auto"
          >
            {/* The shared pair, mounted rather than re-implemented. It supplies
                rest of the chrome instead of pinning at the kit's 32px. */}
            <UndoRedo history={history} variant="secondary" class="tlib-pe-history" />
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
              onClick={requestCancel}
            >
              {T("btn_cancel")}
            </Button>
          </PanelHover>

          {/* Left toolbar */}
          <PanelHover
            onHoverChange={hover}
            class={`absolute tlib-pe-toolbar ${PANEL_SURFACE} flex flex-col pointer-events-auto`}
          >
            {/* `data-tool` / `data-active` on every button in this toolbar: the
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
            <Button
              toggle
              data-tool="scale"
              data-active={propEditorState.mode === "scale" ? "" : undefined}
              title={T("btn_scale_title")}
              variant={toolVariant(propEditorState.mode === "scale")}
              pressed={propEditorState.mode === "scale"}
              onPressedChange={() => setPropEditorMode("scale")}
              class="tlib-pe-tool font-mono font-semibold"
            >
              S
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

          {/* Right: properties */}
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
                    onChange={(v) => editPosition(axis.key, axis.label, v)}
                    onCommit={() => history.commit()}
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
                    onChange={(v) => editRotation(axis.key, axis.label, v)}
                    onCommit={() => history.commit()}
                  />
                )}
              </For>

              <Separator class="bg-border/60 tlib-pe-sep" />

              {/* ONE field, not three. The attachment matrix would carry a
                  and no axis label — `S` is the whole vocabulary. */}
              <span class={SECTION_LABEL}>{T("section_scale")}</span>
              <PropField
                label="S"
                value={propEditorState.propData.scale}
                onChange={editScale}
                onCommit={() => history.commit()}
              />
            </div>

            {/* The kit's `destructive` variant rather than the hand-mixed
                In-place arming is the whole reason this shape suits it. */}
            <ConfirmDelete
              data-prop-editor-remove=""
              class="tlib-pe-remove font-mono font-semibold"
              title={T("btn_remove_prop_title")}
              armedTitle={T("btn_remove_prop_armed")}
              armedChildren={T("btn_remove_prop_armed")}
              onConfirm={() => nui("propEditorRemove")}
            >
              {T("btn_remove_prop")}
            </ConfirmDelete>
          </PanelHover>

          {/* Bottom hint bar */}
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
                <span class="text-foreground">{T("hint_s_key")}</span> {T("hint_s_label")}
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
            <Separator orientation="vertical" class="tlib-pe-sep-v bg-border/60" />
            {/* The shared hint strip, untranslated and unrestyled on purpose.
                thing in the bar because it is the only hint that is a chord. */}
            <UndoHint />
          </PanelHover>
        </div>

        {/* THE DISCARD GUARD. Reached only through `requestCancel`. An INLINE
            alertdialog, because a feature reached from an open UI renders inside
            it. NO SCRIM: what is behind it is the live prop being decided about.
            The lossy answer is on the RIGHT -- the opposite hand from Save/Cancel
            above, and both are correct, because this is a destructive
            confirmation and "Keep editing" is its affirmative answer.
            See docs/internal/prop-editor-ui.md. */}
        <Show when={discarding()}>
          <div class="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-auto">
            <FocusTrap
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="tlib-pe-discard-title"
              aria-describedby="tlib-pe-discard-body"
              class="tlib-pe-discard bg-popover border border-border flex flex-col"
            >
              <span
                id="tlib-pe-discard-title"
                class="font-mono font-semibold text-foreground tlib-pe-discard-title"
              >
                {T("discard_title")}
              </span>
              <p id="tlib-pe-discard-body" class="text-muted-foreground tlib-pe-discard-body">
                {T("discard_body")}
              </p>
              <div class="flex justify-end tlib-pe-discard-actions">
                {/* Focused imperatively rather than with `autofocus`: Ark's trap
                    measured working inside CEF. */}
                <Button
                  data-prop-editor-keep=""
                  class="tlib-pe-btn font-mono font-semibold"
                  ref={(el: HTMLButtonElement) => queueMicrotask(() => el.focus())}
                  onClick={() => setDiscarding(false)}
                >
                  {T("discard_keep")}
                </Button>
                <Button
                  data-prop-editor-discard=""
                  variant="destructive"
                  class="tlib-pe-btn font-mono font-semibold"
                  onClick={discard}
                >
                  {T("discard_confirm")}
                </Button>
              </div>
            </FocusTrap>
          </div>
        </Show>
      </div>
    </Show>
  );
}

export default PropEditor;
