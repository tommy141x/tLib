/**
 * The prop editor's undo MODEL: what one entry is, and what putting one back
 * costs.
 *
 * One tag, no key
 *
 * An entry here is the transform of the one record being edited —
 * `{x, y, z, rx, ry, rz, scale}`, seven numbers, and nothing else. There is
 * exactly one thing on screen, so `UndoHistory`'s `key` machinery buys nothing:
 * the rule in `shared/ts/undo.ts` is *either* one tag per element with a `key`,
 * *or* a snapshot of the whole set under one tag with no `key` — never both. This
 * editor is firmly the second, so `remove(key)` is never called and never can be.
 *
 * Compare `client/web/src/layout/LayoutEditor.tsx`, which is the first shape: it
 * registers `layout:<key>` per HUD component because the host can withdraw one
 * mid-session. Nothing can withdraw a prop's transform out from under this editor
 * — the record either exists for the whole session or the editor closed.
 *
 * `equal` is supplied, and has to be
 *
 * `UndoHistory`'s default guard is `Object.is`, and `capture()` here returns a
 * FRESH object every time, so the default never matches and every committed
 * gesture — including one that ended exactly where it started — would record an
 * entry that does nothing. `sameTransform` is a seven-field compare; it costs
 * nothing and it is what makes "nudge the gizmo and put it back" not consume an
 * undo step.
 *
 * A restore has to re-DRIVE the scale, not just store it
 *
 * `scale` is applied through `SetEntityMatrix` basis-vector lengths by
 * `tlib.drivenprop`, and it does NOT survive `AttachEntityToEntity` — so it is
 * re-applied per frame by the driver rather than set once. The Lua half switches
 * between a plain attach and the driver inside `reattach()`, which reads
 * `offset`, `rotation` AND `scale` together (see
 * `shared/imports/propeditor/client.lua:638`). That is why a restore sends all
 * THREE messages rather than only the channels that changed: `propScaled` is what
 * moves the prop between the attached and the driven path, and a `propMoved`
 * that arrived while the Lua half still held the old scale would re-attach at the
 * old one. Sending the full transform makes a restore idempotent and makes the
 * per-frame driver pick the restored value up on its next tick.
 *
 * It is `.ts`, deliberately
 *
 * UnoCSS never scans plain `.ts`, so nothing in this file's prose can leak into a
 * consumer's stylesheet as a real, dead rule. There is no markup here.
 */

import type { UndoableOptions } from "../undo";
import type { PropData, PropEditorMode } from "./types";

/** The one tag. There is one thing being edited, so there is one of these. */
export const PROP_TRANSFORM_TAG = "prop-editor:transform";

/**
 * What an entry is called. The shared button pair renders it as
 * "Undo move · Ctrl Z".
 *
 * The gizmo's three labels and the numeric fields' labels are deliberately
 * DISJOINT, because `UndoHistory.push` extends an open batch when the label
 * matches: a gizmo drag must not silently join itself onto the batch a field left
 * open, and stepping the X field must not join the one Y left open. "set scale"
 * rather than "scale" is the whole reason that is true for the scale pair.
 */
export const GIZMO_UNDO_LABEL: Record<PropEditorMode, string> = {
  translate: "move",
  rotate: "rotate",
  scale: "scale",
};

/** The label for a numeric field. `label` is the axis caption — `X`, `RZ`, `S`. */
export function fieldUndoLabel(label: string): string {
  return `set ${label}`;
}

/**
 * The no-op guard. Seven `===` comparisons.
 *
 * `===` and not `Object.is`, for one reason that matters: `Object.is(-0, 0)` is
 * false, and a rotation that passes through zero really does produce `-0` on this
 * path. Under `Object.is` that would record an entry whose before and after are
 * the same number.
 */
export function sameTransform(a: PropData, b: PropData): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.rx === b.rx &&
    a.ry === b.ry &&
    a.rz === b.rz &&
    a.scale === b.scale
  );
}

/** One NUI action name and the payload the Lua half expects under it. */
export type PropTransformMessage = readonly [action: string, data: Record<string, number>];

/**
 * The three messages that put a whole transform back on the game side.
 *
 * All three, always — see the header. The order is position, rotation, scale so
 * the last `reattach()` the Lua half runs is the one that has every value.
 */
export function transformMessages(pd: PropData): PropTransformMessage[] {
  return [
    ["propMoved", { x: pd.x, y: pd.y, z: pd.z }],
    ["propRotated", { rx: pd.rx, ry: pd.ry, rz: pd.rz }],
    ["propScaled", { scale: pd.scale }],
  ];
}

export interface PropTransformUndoableOptions {
  /**
   * The current transform, readable in the tick it was written.
   *
   * NOT a read of the store proxy. `propEditorTransform()` exists precisely so
   * this is safe — a Solid 2 store write is not synchronously readable, so a
   * `commit()` that re-read the proxy would compare the value from before the
   * last write and discard the entry.
   */
  read: () => PropData;
  /** Put a transform back: the store, the game, and the gizmo handle. */
  write: (pd: PropData) => void;
}

/**
 * The single registration this editor makes.
 *
 *     const dispose = history.register(PROP_TRANSFORM_TAG, propTransformUndoable({ read, write }));
 */
export function propTransformUndoable(
  options: PropTransformUndoableOptions
): UndoableOptions<PropData> {
  return {
    // Cloned, so the entry cannot be mutated afterwards by the live edit it came
    // from — which is exactly what would happen if the store's own object were
    // handed over, since `mergePropEditorPropData` mutates in place.
    capture: () => ({ ...options.read() }),
    restore: (snapshot) => options.write({ ...snapshot }),
    equal: sameTransform,
  };
}
