/**
 * The one undo primitive, and the keyboard registry in front of it.
 *
 * Three things here are not ordinary unit coverage and are worth saying why:
 *
 * 1. **The five `LayoutHistory` scenarios are re-proven, not retired.** They
 *    lived in `layout.test.ts` against `client/web/src/layout/history.ts`, which
 *    is deleted. Deleting a class whose behaviour nothing else asserts is how a
 *    capability quietly stops existing, so each of its scenarios is replayed
 *    against `UndoHistory` below under the heading that names where it came
 *    from. One of them — "no-op gestures do not clear redo" — is the only test
 *    in the tree that ever pinned that rule down.
 *
 * 2. **The nested-editor case is a real pairing, not a thought experiment.**
 *    tRadio's settings app hosts tLib's shared `PropEditor` inside itself. The
 *    module-level singleton this replaced would have given them one stack, so
 *    the test asserts two histories stay independent AND that one Ctrl+Z
 *    reaches only the inner one.
 *
 * 3. **There is a negative control for the registry's depth rule**, because
 *    that rule is the whole of point 2 and a depth-blind registry passes a
 *    carelessly-written version of the test. `FirstScopeWins` must fail exactly
 *    the nested scenarios and pass the rest; a control that passes everything
 *    has had its mechanism stop being load-bearing.
 */

import { describe, expect, test } from "bun:test";
import {
  createUndoHistory,
  UNDO_LIMIT_DEFAULT,
  UndoHistory,
  type UndoState,
} from "../../shared/ts/undo";
import {
  matchUndoKey,
  type UndoKeyEvent,
  UndoKeyRegistry,
  type UndoKeyTarget,
  type UndoScopeOptions,
} from "../../shared/ts/undo-keys";

// Fixtures

/** One editable record, the shape every adopting editor's snapshot really is. */
interface Box {
  value: number;
  name: string;
}

function box(initial: Box = { value: 0, name: "a" }) {
  const state = { ...initial };
  return {
    state,
    /** Register with a structural `equal`, i.e. the no-op guard switched ON. */
    guarded(history: UndoHistory, tag = "box") {
      return history.register<Box>(tag, {
        capture: () => ({ ...state }),
        restore: (snapshot) => Object.assign(state, snapshot),
        equal: (a, b) => a.value === b.value && a.name === b.name,
      });
    },
    /** Register with no `equal`, i.e. the default. */
    bare(history: UndoHistory, tag = "box") {
      return history.register<Box>(tag, {
        capture: () => ({ ...state }),
        restore: (snapshot) => Object.assign(state, snapshot),
      });
    },
  };
}

/**
 * The DOM this needs: one bubble-phase keydown listener on a target. Everything
 * about the event — modifiers, `repeat`, `target`, `defaultPrevented` — is
 * passed in explicitly by each scenario rather than simulated.
 */
class FakeTarget implements UndoKeyTarget {
  private listeners: ((event: UndoKeyEvent) => void)[] = [];
  addEventListener(_type: string, listener: (event: UndoKeyEvent) => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: UndoKeyEvent) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  get attachedCount() {
    return this.listeners.length;
  }
  press(init: Partial<UndoKeyEvent> & { key: string }): { prevented: boolean } {
    let prevented = false;
    const event: UndoKeyEvent = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      ...init,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    };
    for (const listener of [...this.listeners]) listener(event);
    return { prevented };
  }
}

const ctrlZ = { key: "z", ctrlKey: true } as const;
const ctrlShiftZ = { key: "z", ctrlKey: true, shiftKey: true } as const;
const ctrlY = { key: "y", ctrlKey: true } as const;

// The primitive

describe("UndoHistory — instance scoping", () => {
  test("two histories are independent, which the module singleton could not be", () => {
    // The concrete case: tRadio's settings app hosting tLib's shared PropEditor.
    const outer = createUndoHistory({ label: "tradio-settings" });
    const inner = createUndoHistory({ label: "prop-editor" });
    const outerBox = box({ value: 10, name: "settings" });
    const innerBox = box({ value: 20, name: "prop" });
    outerBox.guarded(outer);
    innerBox.guarded(inner);

    outer.with("edit settings", ["box"], () => {
      outerBox.state.value = 11;
    });
    inner.with("move prop", ["box"], () => {
      innerBox.state.value = 21;
    });

    inner.undo();
    expect(innerBox.state.value).toBe(20);
    // The outer app's edit is untouched, and it still has it to undo.
    expect(outerBox.state.value).toBe(11);
    expect(outer.canUndo()).toBe(true);
    expect(inner.canUndo()).toBe(false);
  });

  test("the same tag name in two histories is two different stores", () => {
    const a = createUndoHistory();
    const b = createUndoHistory();
    const boxA = box({ value: 1, name: "a" });
    const boxB = box({ value: 2, name: "b" });
    boxA.guarded(a, "box");
    boxB.guarded(b, "box");
    a.with("edit", ["box"], () => {
      boxA.state.value = 99;
    });
    a.undo();
    expect(boxA.state.value).toBe(1);
    expect(boxB.state.value).toBe(2);
  });
});

describe("UndoHistory — batching", () => {
  test("same label and key extends one batch; a whole drag is one entry", () => {
    const history = new UndoHistory();
    const subject = box({ value: 0, name: "a" });
    subject.guarded(history);

    for (let frame = 1; frame <= 50; frame++) {
      history.push("move Speedometer", ["box"], "hud.speedo");
      subject.state.value = frame;
    }
    history.commit();

    expect(history.state().undoDepth).toBe(1);
    history.undo();
    expect(subject.state.value).toBe(0);
  });

  test("a different label closes the open batch and opens a new one", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);

    history.push("move", ["box"]);
    subject.state.value = 1;
    history.push("resize", ["box"]);
    subject.state.value = 2;
    history.commit();

    expect(history.state().undoDepth).toBe(2);
    expect(history.undoLabel()).toBe("resize");
    history.undo();
    expect(subject.state.value).toBe(1);
    history.undo();
    expect(subject.state.value).toBe(0);
  });

  test("the same label under a different key is a different entry", () => {
    const history = new UndoHistory();
    const one = box({ value: 0, name: "one" });
    const two = box({ value: 0, name: "two" });
    one.guarded(history, "one");
    two.guarded(history, "two");

    history.push("reset", ["one"], "a");
    one.state.value = 1;
    history.push("reset", ["two"], "b");
    two.state.value = 2;
    history.commit();

    expect(history.state().undoDepth).toBe(2);
  });

  test("extending a batch with a new tag captures that tag's before", () => {
    const history = new UndoHistory();
    const one = box({ value: 1, name: "one" });
    const two = box({ value: 2, name: "two" });
    one.guarded(history, "one");
    two.guarded(history, "two");

    history.push("paint", ["one"]);
    one.state.value = 11;
    // The second store only joins the gesture half way through, which is what
    // tELS's drag-paint does when the stroke crosses into another store.
    history.push("paint", ["one", "two"]);
    two.state.value = 22;
    history.commit();

    history.undo();
    expect(one.state.value).toBe(1);
    expect(two.state.value).toBe(2);
  });

  test("with() commits even when the body throws", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    expect(() =>
      history.with("edit", ["box"], () => {
        subject.state.value = 5;
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(history.state().undoDepth).toBe(1);
    history.undo();
    expect(subject.state.value).toBe(0);
  });

  test("abort() throws the open batch away without recording it", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.push("move", ["box"]);
    subject.state.value = 7;
    // A cancelled gesture: the caller has already put the old value back.
    subject.state.value = 0;
    history.abort();
    expect(history.canUndo()).toBe(false);
    expect(history.state().undoDepth).toBe(0);
  });

  test("an open batch reads as dirty, because something visible has changed", () => {
    const history = new UndoHistory();
    box().guarded(history);
    expect(history.isDirty()).toBe(false);
    history.push("move", ["box"]);
    expect(history.isDirty()).toBe(true);
    // Nothing changed, so the commit is discarded and dirty goes back down.
    history.commit();
    expect(history.isDirty()).toBe(false);
  });

  test("undo() closes an open batch first, so a drag is undoable without releasing", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.push("move", ["box"]);
    subject.state.value = 3;
    expect(history.undo()).toEqual({ label: "move", key: undefined });
    expect(subject.state.value).toBe(0);
  });
});

describe("UndoHistory — the no-op guard", () => {
  test("a commit whose before and after compare equal records nothing", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.push("move", ["box"]);
    history.commit();
    expect(history.canUndo()).toBe(false);
  });

  test("a discarded commit does not clear the redo stack", () => {
    // Ported from `layout.test.ts`: "no-op gestures do not clear redo, new edits
    // do". A gesture that ended where it started is not a new branch of history.
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.with("edit", ["box"], () => {
      /* changes nothing */
    });
    expect(history.canRedo()).toBe(true);

    history.with("edit", ["box"], () => {
      subject.state.value = 2;
    });
    expect(history.canRedo()).toBe(false);
  });

  test("the guard is per tag, supplied at registration — not hard-coded", () => {
    // This is the whole reason `LayoutHistory` could not be reused: it compared
    // with `sameLayout` and nothing else. Here one history holds a tag that
    // knows how to compare itself and a tag that does not.
    const history = new UndoHistory();
    const guardedBox = box({ value: 0, name: "guarded" });
    const bareBox = box({ value: 0, name: "bare" });
    guardedBox.guarded(history, "guarded");
    bareBox.bare(history, "bare");

    history.with("touch", ["guarded"], () => {});
    expect(history.state().undoDepth).toBe(0);

    // Default `equal` is `Object.is`, and a fresh snapshot object is never
    // identical to another — so the default never silently discards anything.
    history.with("touch", ["bare"], () => {});
    expect(history.state().undoDepth).toBe(1);
  });

  test("a batch with one changed tag among several is kept", () => {
    const history = new UndoHistory();
    const one = box({ value: 0, name: "one" });
    const two = box({ value: 0, name: "two" });
    one.guarded(history, "one");
    two.guarded(history, "two");
    history.with("edit", ["one", "two"], () => {
      two.state.value = 1;
    });
    expect(history.state().undoDepth).toBe(1);
  });
});

describe("UndoHistory — remove(key)", () => {
  test("drops that key's entries from BOTH stacks", () => {
    // Ported from `layout.test.ts`: "removal fences undo and redo for a stopped
    // resource". `remove` is for a key the HOST withdrew — the game resource
    // unregistered that HUD component — not for a user-initiated delete.
    const history = new UndoHistory();
    const a = box({ value: 0, name: "a" });
    const b = box({ value: 0, name: "b" });
    a.guarded(history, "a");
    b.guarded(history, "b");

    history.with(
      "edit a",
      ["a"],
      () => {
        a.state.value = 1;
      },
      "a"
    );
    history.with(
      "edit b",
      ["b"],
      () => {
        b.state.value = 1;
      },
      "b"
    );
    history.undo(); // b's entry is now on the redo stack

    expect(history.canRedo()).toBe(true);
    history.remove("b");
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toEqual({ label: "edit a", key: "a" });

    history.remove("a");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  test("leaves entries about other keys, and keyless entries, alone", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("keyless", ["box"], () => {
      subject.state.value = 1;
    });
    history.with(
      "keyed",
      ["box"],
      () => {
        subject.state.value = 2;
      },
      "gone"
    );
    history.remove("gone");
    expect(history.state().undoDepth).toBe(1);
    expect(history.undoLabel()).toBe("keyless");
  });

  test("an open batch for that key is aborted", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.push("move", ["box"], "gone");
    subject.state.value = 4;
    history.remove("gone");
    history.commit();
    expect(history.canUndo()).toBe(false);
  });
});

describe("UndoHistory — bounds and redo invalidation", () => {
  test("the cap defaults to 100 and drops the OLDEST entry", () => {
    expect(UNDO_LIMIT_DEFAULT).toBe(100);
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    for (let i = 1; i <= 120; i++)
      history.with(`edit ${i}`, ["box"], () => {
        subject.state.value = i;
      });
    expect(history.state().undoDepth).toBe(100);
    // 120 edits, 100 kept: the oldest reachable state is the one edit 21 began
    // from, i.e. value 20.
    for (let i = 0; i < 100; i++) history.undo();
    expect(subject.state.value).toBe(20);
    expect(history.canUndo()).toBe(false);
  });

  test("a custom limit is honoured", () => {
    // Ported from `layout.test.ts`: "history is bounded and session clear drops
    // both directions".
    const history = new UndoHistory({ limit: 2 });
    const subject = box();
    subject.guarded(history);
    for (let x = 1; x <= 3; x++)
      history.with("edit", ["box"], () => {
        subject.state.value = x;
      });
    expect(history.undo()).not.toBeNull();
    expect(subject.state.value).toBe(2);
    expect(history.undo()).not.toBeNull();
    expect(subject.state.value).toBe(1);
    expect(history.undo()).toBeNull();
    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  test("a new entry invalidates redo", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("first", ["box"], () => {
      subject.state.value = 1;
    });
    history.with("second", ["box"], () => {
      subject.state.value = 2;
    });
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.with("third", ["box"], () => {
      subject.state.value = 9;
    });
    expect(history.canRedo()).toBe(false);
    expect(history.redoLabel()).toBeNull();
  });

  test("one entry restores its start, redo restores its end", () => {
    // Ported from `layout.test.ts`: "one gesture restores its starting snapshot,
    // redo restores its end".
    const history = new UndoHistory();
    const subject = box({ value: 0, name: "a" });
    subject.guarded(history);
    history.with("drag", ["box"], () => {
      subject.state.value = 3;
      subject.state.name = "b";
    });
    expect(history.undo()).toEqual({ label: "drag", key: undefined });
    expect(subject.state).toEqual({ value: 0, name: "a" });
    expect(history.canUndo()).toBe(false);
    expect(history.redo()).toEqual({ label: "drag", key: undefined });
    expect(subject.state).toEqual({ value: 3, name: "b" });
  });

  test("snapshots are owned copies: mutating the store later cannot rewrite history", () => {
    // Ported from `layout.test.ts`: "snapshots are owned copies ...". The
    // ownership is the registrant's job — `capture` returns a copy — and this
    // asserts the history does not hand a live reference back out either.
    const history = new UndoHistory();
    const subject = box({ value: 0, name: "a" });
    subject.guarded(history);
    history.with("drag", ["box"], () => {
      subject.state.value = 5;
    });
    subject.state.value = 999;
    history.undo();
    expect(subject.state.value).toBe(0);
    history.redo();
    expect(subject.state.value).toBe(5);
  });
});

describe("UndoHistory — registration lifetime", () => {
  test("an unregistered tag is skipped on restore rather than throwing", () => {
    const history = new UndoHistory();
    const subject = box();
    const dispose = subject.guarded(history);
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    dispose();
    expect(() => history.undo()).not.toThrow();
    // Skipped, so the value stands. This is why the layout editor pairs its
    // unregister with `remove(key)` rather than relying on the skip.
    expect(subject.state.value).toBe(1);
    expect(history.registeredTags()).toEqual([]);
  });

  test("a tag that went away mid-batch is never treated as unchanged", () => {
    const history = new UndoHistory();
    const subject = box();
    const dispose = subject.guarded(history);
    history.push("edit", ["box"]);
    dispose();
    history.commit();
    // Guessing "equal" here would silently drop the whole batch.
    expect(history.state().undoDepth).toBe(1);
  });

  test("the disposer is safe to call twice and does not unregister a replacement", () => {
    const history = new UndoHistory();
    const first = box();
    const dispose = first.guarded(history, "box");
    const second = box();
    second.guarded(history, "box");
    dispose();
    dispose();
    expect(history.registeredTags()).toEqual(["box"]);
  });
});

describe("UndoHistory — onChange", () => {
  test("the payload carries REDO availability, not just dirty", () => {
    /*
     * The defect this fixes. The old module emitted one boolean, `canUndo()`, so
     * a listener was never told that redo availability had changed. tELS got
     * away with it because it only drove a dirty pill; a redo BUTTON wired to it
     * would never enable, which is exactly what the shared UI affordance is.
     */
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    const seen: UndoState[] = [];
    history.onChange((state) => seen.push(state));

    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    history.undo();

    const last = seen[seen.length - 1]!;
    expect(last.canRedo).toBe(true);
    expect(last.canUndo).toBe(false);
    expect(last.redoLabel).toBe("edit");
    expect(last.undoLabel).toBeNull();
    // Every emission since the one that enabled redo has said so, and at least
    // one emission reported `canRedo: true` — the old payload could not.
    expect(seen.some((state) => state.canRedo)).toBe(true);
  });

  test("the listener is called immediately with the current state", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    // A UI that mounts after the first edit must not show a stale pair of
    // buttons, so there is no first-render gap to fill.
    let state: UndoState | null = null;
    history.onChange((next) => {
      state = next;
    });
    expect(state!.canUndo).toBe(true);
    expect(state!.undoLabel).toBe("edit");
  });

  test("it fires for push, commit, undo, redo, remove and clear", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    let count = 0;
    history.onChange(() => {
      count++;
    });
    const after = (fn: () => void) => {
      const before = count;
      fn();
      return count - before;
    };
    expect(after(() => history.push("edit", ["box"], "k"))).toBeGreaterThan(0);
    subject.state.value = 1;
    expect(after(() => history.commit())).toBeGreaterThan(0);
    expect(after(() => history.undo())).toBeGreaterThan(0);
    expect(after(() => history.redo())).toBeGreaterThan(0);
    expect(after(() => history.remove("k"))).toBeGreaterThan(0);
    expect(after(() => history.clear())).toBeGreaterThan(0);
    // Nothing to drop, so nothing changed and nothing is announced.
    expect(after(() => history.remove("k"))).toBe(0);
  });

  test("unsubscribing stops it, and is safe to call twice", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    let count = 0;
    const off = history.onChange(() => {
      count++;
    });
    const atSubscribe = count;
    off();
    off();
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    expect(count).toBe(atSubscribe);
  });

  test("state() reports both depths and both labels", () => {
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("first", ["box"], () => {
      subject.state.value = 1;
    });
    history.with("second", ["box"], () => {
      subject.state.value = 2;
    });
    history.undo();
    expect(history.state()).toEqual({
      canUndo: true,
      canRedo: true,
      dirty: true,
      undoLabel: "first",
      redoLabel: "second",
      undoDepth: 1,
      redoDepth: 1,
    });
  });
});

// The keyboard registry

describe("matchUndoKey", () => {
  const press = (init: Partial<UndoKeyEvent> & { key: string }): UndoKeyEvent => ({
    defaultPrevented: false,
    preventDefault: () => {},
    ...init,
  });

  test("Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo", () => {
    expect(matchUndoKey(press(ctrlZ))).toBe("undo");
    expect(matchUndoKey(press(ctrlShiftZ))).toBe("redo");
    expect(matchUndoKey(press(ctrlY))).toBe("redo");
    expect(matchUndoKey(press({ key: "Z", ctrlKey: true }))).toBe("undo");
    expect(matchUndoKey(press({ key: "z", metaKey: true }))).toBe("undo");
  });

  test("an unmodified key, a bare Shift+Z and Ctrl+Alt+Z are not undo shortcuts", () => {
    expect(matchUndoKey(press({ key: "z" }))).toBeNull();
    expect(matchUndoKey(press({ key: "z", shiftKey: true }))).toBeNull();
    expect(matchUndoKey(press({ key: "z", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchUndoKey(press({ key: "a", ctrlKey: true }))).toBeNull();
  });
});

describe("UndoKeyRegistry", () => {
  test("one press reaches the INNERMOST scope only", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const outer = new UndoHistory();
    const inner = new UndoHistory();
    const outerBox = box({ value: 0, name: "outer" });
    const innerBox = box({ value: 0, name: "inner" });
    outerBox.guarded(outer);
    innerBox.guarded(inner);
    outer.with("edit", ["box"], () => {
      outerBox.state.value = 1;
    });
    inner.with("edit", ["box"], () => {
      innerBox.state.value = 1;
    });

    registry.add({ history: outer, depth: 0, label: "tradio-settings" });
    registry.add({ history: inner, depth: 1, label: "prop-editor" });

    target.press(ctrlZ);
    expect(innerBox.state.value).toBe(0);
    expect(outerBox.state.value).toBe(1);
  });

  test("equal depths resolve newest-registered-first", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const first = new UndoHistory();
    const second = new UndoHistory();
    const firstBox = box();
    const secondBox = box();
    firstBox.guarded(first);
    secondBox.guarded(second);
    first.with("edit", ["box"], () => {
      firstBox.state.value = 1;
    });
    second.with("edit", ["box"], () => {
      secondBox.state.value = 1;
    });
    registry.add({ history: first });
    registry.add({ history: second });
    target.press(ctrlZ);
    expect(secondBox.state.value).toBe(0);
    expect(firstBox.state.value).toBe(1);
  });

  test("an inactive scope stands down so the host underneath receives the key", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const host = new UndoHistory();
    const hidden = new UndoHistory();
    const hostBox = box();
    const hiddenBox = box();
    hostBox.guarded(host);
    hiddenBox.guarded(hidden);
    host.with("edit", ["box"], () => {
      hostBox.state.value = 1;
    });
    hidden.with("edit", ["box"], () => {
      hiddenBox.state.value = 1;
    });
    registry.add({ history: host, depth: 0 });
    registry.add({ history: hidden, depth: 9, active: () => false });
    target.press(ctrlZ);
    expect(hostBox.state.value).toBe(0);
    expect(hiddenBox.state.value).toBe(1);
  });

  test("a scope stands down while focus is in a text field, keeping its native undo", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    registry.add({ history });

    const typing = target.press({ ...ctrlZ, target: { tagName: "INPUT" } });
    expect(subject.state.value).toBe(1);
    // Not claimed either, so the field's own undo still happens.
    expect(typing.prevented).toBe(false);

    expect(target.press({ ...ctrlZ, target: { isContentEditable: true } }).prevented).toBe(false);
    expect(target.press({ ...ctrlZ, target: { tagName: "DIV" } }).prevented).toBe(true);
    expect(subject.state.value).toBe(0);
  });

  test("ignoreWhenTyping:false opts a surface with no text entry back in", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    registry.add({ history, ignoreWhenTyping: false });
    target.press({ ...ctrlZ, target: { tagName: "INPUT" } });
    expect(subject.state.value).toBe(0);
  });

  test("auto-repeat does not travel, but is still claimed from the browser", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    for (const value of [1, 2, 3])
      history.with(`edit ${value}`, ["box"], () => {
        subject.state.value = value;
      });
    registry.add({ history });

    expect(target.press(ctrlZ).prevented).toBe(true);
    expect(subject.state.value).toBe(2);
    const held = target.press({ ...ctrlZ, repeat: true });
    expect(held.prevented).toBe(true);
    expect(subject.state.value).toBe(2);
  });

  test("allowRepeat:true walks the stack while held", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    for (const value of [1, 2, 3])
      history.with(`edit ${value}`, ["box"], () => {
        subject.state.value = value;
      });
    registry.add({ history, allowRepeat: true });
    target.press(ctrlZ);
    target.press({ ...ctrlZ, repeat: true });
    expect(subject.state.value).toBe(1);
  });

  test("a press something else already handled is left alone", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const history = new UndoHistory();
    const subject = box();
    subject.guarded(history);
    history.with("edit", ["box"], () => {
      subject.state.value = 1;
    });
    registry.add({ history });
    registry.handle({
      ...ctrlZ,
      defaultPrevented: true,
      preventDefault: () => {},
    });
    expect(subject.state.value).toBe(1);
  });

  test("onUndo/onRedo replace the default so buttons and keys share one path", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    const history = new UndoHistory();
    const calls: string[] = [];
    registry.add({
      history,
      onUndo: () => calls.push("undo"),
      onRedo: () => calls.push("redo"),
    });
    target.press(ctrlZ);
    target.press(ctrlShiftZ);
    target.press(ctrlY);
    expect(calls).toEqual(["undo", "redo", "redo"]);
  });

  test("the listener is attached on first scope and detached when the last one goes", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    expect(target.attachedCount).toBe(0);
    const off = registry.add({ history: new UndoHistory() });
    expect(target.attachedCount).toBe(1);
    off();
    off();
    expect(target.attachedCount).toBe(0);
  });

  test("diagnostics name the owner", () => {
    const target = new FakeTarget();
    const registry = new UndoKeyRegistry(target);
    registry.add({ history: new UndoHistory(), depth: 0, label: "host" });
    registry.add({ history: new UndoHistory(), depth: 2, label: "inner" });
    expect(registry.diagnostics().owner).toBe("inner");
    registry.reset();
    expect(registry.diagnostics()).toEqual({ scopes: [], attached: false, owner: null });
  });
});

// Negative control

/**
 * Depth-blind: always the FIRST registered scope.
 *
 * It must fail exactly the two scenarios whose rule is resolution order — the
 * nested editor and the newest-first tie-break — and it must PASS the rest,
 * because none of those depend on resolution. A control that fails everything
 * is not blind to one mechanism, it is just broken; a control that fails
 * nothing means the mechanism it is blind to has stopped being load-bearing.
 */
class FirstScopeWins {
  private readonly scopes: UndoScopeOptions[] = [];
  add(options: UndoScopeOptions): () => void {
    this.scopes.push(options);
    return () => {};
  }
  press(event: UndoKeyEvent): void {
    const action = matchUndoKey(event);
    if (!action) return;
    const scope = this.scopes.find((s) => !s.active || s.active());
    if (!scope) return;
    if (action === "undo") scope.onUndo ? scope.onUndo() : scope.history.undo();
    else scope.onRedo ? scope.onRedo() : scope.history.redo();
  }
}

describe("negative control: a depth-blind registry", () => {
  const press = (init: Partial<UndoKeyEvent> & { key: string }): UndoKeyEvent => ({
    defaultPrevented: false,
    preventDefault: () => {},
    ...init,
  });

  test("sends the nested press to the OUTER editor, which is the bug", () => {
    const control = new FirstScopeWins();
    const outer = new UndoHistory();
    const inner = new UndoHistory();
    const outerBox = box();
    const innerBox = box();
    outerBox.guarded(outer);
    innerBox.guarded(inner);
    outer.with("edit", ["box"], () => {
      outerBox.state.value = 1;
    });
    inner.with("edit", ["box"], () => {
      innerBox.state.value = 1;
    });
    control.add({ history: outer, depth: 0 });
    control.add({ history: inner, depth: 1 });
    control.press(press(ctrlZ));
    // The real registry asserts the exact opposite of both of these.
    expect(outerBox.state.value).toBe(0);
    expect(innerBox.state.value).toBe(1);
  });

  test("gets the newest-first tie-break backwards", () => {
    const control = new FirstScopeWins();
    const first = new UndoHistory();
    const second = new UndoHistory();
    const firstBox = box();
    const secondBox = box();
    firstBox.guarded(first);
    secondBox.guarded(second);
    first.with("edit", ["box"], () => {
      firstBox.state.value = 1;
    });
    second.with("edit", ["box"], () => {
      secondBox.state.value = 1;
    });
    control.add({ history: first });
    control.add({ history: second });
    control.press(press(ctrlZ));
    expect(firstBox.state.value).toBe(0);
    expect(secondBox.state.value).toBe(1);
  });

  test("still gets `active` right, so that rule is not what the two above prove", () => {
    const control = new FirstScopeWins();
    const host = new UndoHistory();
    const hidden = new UndoHistory();
    const hostBox = box();
    hostBox.guarded(host);
    host.with("edit", ["box"], () => {
      hostBox.state.value = 1;
    });
    control.add({ history: hidden, active: () => false });
    control.add({ history: host });
    control.press(press(ctrlZ));
    expect(hostBox.state.value).toBe(0);
  });
});
