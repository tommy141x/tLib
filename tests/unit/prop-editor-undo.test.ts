/**
 * The prop editor's undo MODEL, headless.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. tLib has no happy-dom, no jsdom and no
 * `@solidjs/testing-library`, so there are ZERO component tests in this package
 * and none can be added by this suite. Nothing below renders `PropEditor`,
 * presses Escape, clicks Cancel or opens the discard prompt. What it pins is the
 * part of the fix that is plain data and plain functions:
 *
 *   - the snapshot/restore round trip for the seven numbers;
 *   - `sameTransform` as the no-op guard, including the two cases the DEFAULT
 *     guard gets wrong;
 *   - `transformMessages` sending all three channels, which is what makes a
 *     restored scale survive the per-frame driver;
 *   - the dirty flag, including that an OPEN batch is already dirty;
 *   - batch collapse — a drag's worth of writes is one entry, and a stepper
 *     burst under one label is one entry.
 *
 * The wiring from those to the chrome (which handler calls `push`, which button
 * calls `requestCancel`) is verified by `typecheck:shared` and by reading the
 * component, and by nothing else. Said plainly here so a later reader does not
 * mistake a green run for proof that Escape prompts.
 */

import { describe, expect, test } from "bun:test";
import type { PropData } from "../../internal/shared-ts/prop-editor/types";
import {
  fieldUndoLabel,
  GIZMO_UNDO_LABEL,
  PROP_TRANSFORM_TAG,
  propTransformUndoable,
  sameTransform,
  transformMessages,
} from "../../internal/shared-ts/prop-editor/undo";
import { UndoHistory } from "../../shared/ts/undo";

const ORIGIN: PropData = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };

/**
 * The editor's state, standing in for the store + the NUI channel.
 *
 * `live` is a plain object read synchronously, which is exactly what
 * `propEditorTransform()` is in the real editor and for the same reason: a Solid
 * 2 store write is not readable in the tick it happened, so a `commit()` that
 * re-read the proxy would compare the pre-write value and throw the entry away.
 */
function editor(initial: PropData = ORIGIN) {
  let live: PropData = { ...initial };
  /** Every message the "Lua half" was sent, in order. */
  const sent: { action: string; data: Record<string, number> }[] = [];
  const history = new UndoHistory({ label: "prop-editor" });
  const dispose = history.register<PropData>(
    PROP_TRANSFORM_TAG,
    propTransformUndoable({
      read: () => live,
      write: (pd) => {
        live = { ...pd };
        for (const [action, data] of transformMessages(pd)) sent.push({ action, data });
      },
    })
  );
  return {
    history,
    sent,
    dispose,
    now: () => live,
    /** A write that does NOT touch the history — a drag frame, or a field edit. */
    write: (partial: Partial<PropData>) => {
      live = { ...live, ...partial };
    },
  };
}

// The snapshot

describe("the transform snapshot is seven numbers, and restoring it is exact", () => {
  test("undo puts all seven back, redo takes them forward again", () => {
    const e = editor();
    e.history.push("move", [PROP_TRANSFORM_TAG]);
    e.write({ x: 1.5, y: -2, z: 0.25, rx: 90, ry: 15, rz: -45, scale: 2.5 });
    e.history.commit();

    expect(e.history.state().undoDepth).toBe(1);
    e.history.undo();
    expect(e.now()).toEqual(ORIGIN);
    e.history.redo();
    expect(e.now()).toEqual({ x: 1.5, y: -2, z: 0.25, rx: 90, ry: 15, rz: -45, scale: 2.5 });
  });

  test("the captured snapshot is a COPY, so a later live write cannot rewrite history", () => {
    // The real hazard: `mergePropEditorPropData` mutates the store's object in
    // place, so handing the history that object rather than a clone would make
    // every entry track the current value and undo would restore nothing.
    const e = editor();
    e.history.push("move", [PROP_TRANSFORM_TAG]);
    e.write({ x: 5 });
    e.history.commit();
    e.write({ x: 99 });
    e.history.undo();
    expect(e.now().x).toBe(0);
  });

  test("restore sends ALL THREE channels, not only the one that changed", () => {
    // Why: `scale` is driven through SetEntityMatrix by tlib.drivenprop and does
    // not survive AttachEntityToEntity, and the Lua half's `reattach()` chooses
    // between the attached and the driven path from the scale it currently holds.
    // A restore that sent only `propMoved` would re-attach at the old scale.
    const e = editor();
    e.history.push(fieldUndoLabel("X"), [PROP_TRANSFORM_TAG]);
    e.write({ x: 3 });
    e.history.commit();
    e.history.undo();
    expect(e.sent.map((m) => m.action)).toEqual(["propMoved", "propRotated", "propScaled"]);
    // Scale last, so the final reattach is the one that has every value.
    expect(e.sent[2]).toEqual({ action: "propScaled", data: { scale: 1 } });
  });

  test("the message payloads are the exact keys the Lua callbacks read", () => {
    expect(transformMessages({ ...ORIGIN, x: 1, ry: 2, scale: 3 })).toEqual([
      ["propMoved", { x: 1, y: 0, z: 0 }],
      ["propRotated", { rx: 0, ry: 2, rz: 0 }],
      ["propScaled", { scale: 3 }],
    ]);
  });
});

// The no-op guard

describe("sameTransform is the guard the default cannot be", () => {
  test("two equal transforms in different objects compare equal", () => {
    expect(sameTransform({ ...ORIGIN }, { ...ORIGIN })).toBe(true);
  });

  test("every one of the seven fields is compared", () => {
    for (const key of ["x", "y", "z", "rx", "ry", "rz", "scale"] as const) {
      expect(sameTransform(ORIGIN, { ...ORIGIN, [key]: 7 })).toBe(false);
    }
  });

  test("-0 and 0 are the same transform", () => {
    // `Object.is(-0, 0)` is false, and a rotation dragged through zero really
    // does produce -0 on this path. Under the default guard that is an entry
    // whose before and after are the same number.
    expect(sameTransform(ORIGIN, { ...ORIGIN, rz: -0 })).toBe(true);
  });

  test("the DEFAULT guard would record a no-op entry, which is why one is supplied", () => {
    const unguarded = new UndoHistory();
    let live: PropData = { ...ORIGIN };
    unguarded.register<PropData>(PROP_TRANSFORM_TAG, {
      capture: () => ({ ...live }),
      restore: (pd) => {
        live = { ...pd };
      },
      // No `equal` — the default is Object.is on a fresh object, i.e. never equal.
    });
    unguarded.push("move", [PROP_TRANSFORM_TAG]);
    unguarded.commit();
    expect(unguarded.state().undoDepth).toBe(1);

    const guarded = editor();
    guarded.history.push("move", [PROP_TRANSFORM_TAG]);
    guarded.history.commit();
    expect(guarded.history.state().undoDepth).toBe(0);
  });

  test("a gesture that ends where it started records nothing", () => {
    const e = editor();
    e.history.push(GIZMO_UNDO_LABEL.translate, [PROP_TRANSFORM_TAG]);
    e.write({ x: 4 });
    e.write({ x: 0 });
    e.history.commit();
    expect(e.history.state().undoDepth).toBe(0);
  });
});

// Dirty

describe("the dirty flag, which is the whole discard guard", () => {
  test("a fresh session is not dirty", () => {
    expect(editor().history.isDirty()).toBe(false);
  });

  test("an OPEN batch is already dirty — a drag in progress has something to lose", () => {
    const e = editor();
    e.history.push(GIZMO_UNDO_LABEL.rotate, [PROP_TRANSFORM_TAG]);
    e.write({ rx: 10 });
    expect(e.history.isDirty()).toBe(true);
  });

  test("a batch that turns out to be a no-op is not dirty once committed", () => {
    const e = editor();
    e.history.push(GIZMO_UNDO_LABEL.scale, [PROP_TRANSFORM_TAG]);
    expect(e.history.isDirty()).toBe(true);
    e.history.commit();
    expect(e.history.isDirty()).toBe(false);
  });

  test("a real edit leaves it dirty, and undoing back to the start clears it", () => {
    const e = editor();
    e.history.push(fieldUndoLabel("Z"), [PROP_TRANSFORM_TAG]);
    e.write({ z: 1 });
    e.history.commit();
    expect(e.history.isDirty()).toBe(true);
    e.history.undo();
    // Back at the original transform AND back to not-dirty, so Cancel closes in
    // one press again. That equivalence is why `isDirty()` is `canUndo()`.
    expect(e.now()).toEqual(ORIGIN);
    expect(e.history.isDirty()).toBe(false);
  });

  test("clear() on open drops the previous placement's history", () => {
    const e = editor();
    e.history.push("move", [PROP_TRANSFORM_TAG]);
    e.write({ x: 1 });
    e.history.commit();
    e.history.clear();
    expect(e.history.isDirty()).toBe(false);
    expect(e.history.canRedo()).toBe(false);
  });
});

// Batch collapse

describe("batch collapse: one gesture is one entry", () => {
  test("a drag's worth of frames collapses into ONE entry", () => {
    const e = editor();
    e.history.push(GIZMO_UNDO_LABEL.translate, [PROP_TRANSFORM_TAG]);
    for (let frame = 1; frame <= 60; frame += 1) e.write({ x: frame * 0.01 });
    e.history.commit();
    expect(e.history.state().undoDepth).toBe(1);
    e.history.undo();
    expect(e.now().x).toBe(0);
  });

  test("re-pushing the SAME label extends the batch rather than re-capturing before", () => {
    // This is the stepper case: a held ArrowUp on a number input fires `change`
    // on every step, so the editor pushes the same per-axis label repeatedly and
    // commits once from the field's blur.
    const e = editor();
    for (let step = 1; step <= 20; step += 1) {
      e.history.push(fieldUndoLabel("X"), [PROP_TRANSFORM_TAG]);
      e.write({ x: step });
    }
    e.history.commit();
    expect(e.history.state().undoDepth).toBe(1);
    e.history.undo();
    expect(e.now().x).toBe(0);
  });

  test("a DIFFERENT label closes the open batch, so axis-by-axis is entry-by-entry", () => {
    const e = editor();
    e.history.push(fieldUndoLabel("X"), [PROP_TRANSFORM_TAG]);
    e.write({ x: 1 });
    e.history.push(fieldUndoLabel("Y"), [PROP_TRANSFORM_TAG]);
    e.write({ y: 2 });
    e.history.commit();
    expect(e.history.state().undoDepth).toBe(2);
    e.history.undo();
    expect(e.now()).toEqual({ ...ORIGIN, x: 1 });
    e.history.undo();
    expect(e.now()).toEqual(ORIGIN);
  });

  test("the gizmo labels and the field labels are DISJOINT", () => {
    // If they collided, a gizmo drag would silently join the batch a field left
    // open and the two edits would be one undo step. The scale pair is the one
    // that nearly collided — hence "set S" rather than "scale".
    const gizmo = Object.values(GIZMO_UNDO_LABEL);
    const fields = ["X", "Y", "Z", "RX", "RY", "RZ", "S"].map(fieldUndoLabel);
    expect(gizmo.filter((label) => fields.includes(label))).toEqual([]);
    expect(new Set([...gizmo, ...fields]).size).toBe(gizmo.length + fields.length);
  });

  test("an aborted gesture records nothing and leaves redo alone", () => {
    const e = editor();
    e.history.push(fieldUndoLabel("X"), [PROP_TRANSFORM_TAG]);
    e.write({ x: 1 });
    e.history.commit();
    e.history.undo();
    expect(e.history.canRedo()).toBe(true);
    e.history.push(GIZMO_UNDO_LABEL.translate, [PROP_TRANSFORM_TAG]);
    e.write({ x: 9 });
    e.write({ x: 0 });
    e.history.abort();
    expect(e.history.isDirty()).toBe(false);
    expect(e.history.canRedo()).toBe(true);
  });
});

// The one-tag/no-key rule

describe("one tag, no key", () => {
  test("the editor registers exactly one tag", () => {
    const e = editor();
    expect(e.history.registeredTags()).toEqual([PROP_TRANSFORM_TAG]);
  });

  test("entries carry no key, so remove() has nothing to act on and never will", () => {
    // The API rule: EITHER one tag per element with a `key`, OR a snapshot of the
    // set under one tag with no `key` — never both. This editor is the second, so
    // `remove()` is not part of its vocabulary. Asserted rather than assumed,
    // because a stray `key` is what would make a later reader reach for it.
    const e = editor();
    e.history.push("move", [PROP_TRANSFORM_TAG]);
    e.write({ x: 1 });
    e.history.commit();
    expect(e.history.undo()).toEqual({ label: "move", key: undefined });
    e.history.redo();
    e.history.remove("anything");
    expect(e.history.state().undoDepth).toBe(1);
  });
});
