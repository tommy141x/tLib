import type { JSX } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import type { UndoHistory, UndoState } from "@tlib/shared/undo";
import type { Accessor, Component } from "solid-js";
import { createSignal, onCleanup, Show } from "solid-js";
import IconRedo2 from "~icons/lucide/redo-2";
import IconUndo2 from "~icons/lucide/undo-2";
import { Button } from "./button";
import { Kbd, KbdGroup } from "./kbd";
import "./undo-redo.css";

/**
 * The shared undo affordance: the button pair, and the hint strip that names
 * the shortcut.
 */

/**
 * Track a history's state as a signal. `onChange` fires the listener immediately
 * with the current state, so there is no first-render gap.
 *
 * Read this in `compute`, never in the `apply` half of a two-argument
 * `createEffect`: only `compute` tracks in Solid 2, so a read in `apply` never
 * subscribes and the effect runs exactly once.
 *
 * `ownedWrite: true` IS LOAD-BEARING, and the immediate replay is what needs it:
 * `onChange` calls the listener synchronously, so the first write lands while this
 * is still running inside the calling component's owner, which Solid 2 refuses
 * with [REACTIVE_WRITE_IN_OWNED_SCOPE]. Measured in tELS's browser preview: the
 * throw happened during setup, Solid caught it at the nearest boundary, and the
 * whole editor surface was replaced by an error card -- with the only clue a stack
 * pointing at a 32px toolbar button. Do not "clean it up": the write is
 * intentional, and dropping the replay re-introduces the gap this closes.
 */
export function useUndoState(history: UndoHistory): Accessor<UndoState> {
  const [state, setState] = createSignal<UndoState>(history.state(), { ownedWrite: true });
  const off = history.onChange(setState);
  onCleanup(off);
  return state;
}

export interface UndoRedoProps {
  history: UndoHistory;
  /** Force both buttons off regardless of history state — e.g. while saving. */
  disabled?: boolean;
  /** Button size. Default `icon`, the 32px square the layout editor uses. */
  size?: "default" | "sm" | "lg" | "icon";
  /** Button variant. Default `ghost`, so the pair reads as a toolbar. */
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  /** Render the Ctrl+Z / Ctrl+Shift+Z hint strip under the pair. Default false. */
  hint?: boolean;
  class?: string;
  /**
   * Run instead of `history.undo()`. An editor with in-flight gestures has to
   * settle them before travelling, and it must be the same function the keyboard
   * scope calls.
   */
  onUndo?: () => void;
  onRedo?: () => void;
}

/**
 * The button pair. Mount it; do not re-implement it.
 */
export const UndoRedo: Component<UndoRedoProps> = (props) => {
  const state = useUndoState(props.history);
  const size = () => props.size ?? "icon";
  const variant = () => props.variant ?? "ghost";
  const undoTitle = () => {
    const label = state().undoLabel;
    return label ? `Undo ${label} · Ctrl Z` : "Nothing to undo";
  };
  const redoTitle = () => {
    const label = state().redoLabel;
    return label ? `Redo ${label} · Ctrl Shift Z` : "Nothing to redo";
  };

  return (
    <div class={cn("flex flex-col gap-1", props.class)}>
      <div class="flex items-center gap-1">
        <Button
          variant={variant()}
          size={size()}
          aria-label={undoTitle()}
          title={undoTitle()}
          disabled={!!props.disabled || !state().canUndo}
          onClick={() => (props.onUndo ? props.onUndo() : props.history.undo())}
        >
          <IconUndo2 aria-hidden="true" />
        </Button>
        <Button
          variant={variant()}
          size={size()}
          aria-label={redoTitle()}
          title={redoTitle()}
          disabled={!!props.disabled || !state().canRedo}
          onClick={() => (props.onRedo ? props.onRedo() : props.history.redo())}
        >
          <IconRedo2 aria-hidden="true" />
        </Button>
      </div>
      <Show when={props.hint}>
        <UndoHint />
      </Show>
    </div>
  );
};

export interface UndoHintProps {
  class?: string;
}

/**
 * The shortcut hint strip, promoted from tELS's StatusBar. Always visible rather
 * than tooltip-only: inside the game there is no OS tooltip layer worth relying
 * on, and a shortcut nobody is told about is a shortcut nobody uses.
 *
 * THE SIZE IS A CLASS, NOT AN ARBITRARY ONE, AND THAT IS A CORRECTNESS FIX:
 * `unoMerge` files an arbitrary text size and a text colour into ONE conflict
 * group and drops one of them. tLib's `cn` shields that group, but a SHARED
 * component must not rest on that -- tWeb and the `internal/*` projects call
 * `unoMerge` directly. `undo-redo.css` has the full write-up.
 */
export const UndoHint: Component<UndoHintProps> = (props) => (
  <div
    class={cn(
      "tlib-undo-hint flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground",
      props.class
    )}
  >
    <span class="inline-flex items-center gap-1">
      <KbdGroup>
        <Kbd size="sm">Ctrl</Kbd>
        <Kbd size="sm">Z</Kbd>
      </KbdGroup>
      <span>Undo</span>
    </span>
    <span class="inline-flex items-center gap-1">
      <KbdGroup>
        <Kbd size="sm">Ctrl</Kbd>
        <Kbd size="sm">Shift</Kbd>
        <Kbd size="sm">Z</Kbd>
      </KbdGroup>
      <span>Redo</span>
    </span>
  </div>
);

export interface UndoDirtyProps {
  history: UndoHistory;
  /** Default "Unsaved changes". */
  children?: JSX.Element;
  class?: string;
}

/**
 * The dirty pill, promoted from tELS's App header (`.workspace-draft`, "Unsaved
 * vehicle changes").
 */
export const UndoDirty: Component<UndoDirtyProps> = (props) => {
  const state = useUndoState(props.history);
  return (
    <Show when={state().dirty}>
      <span
        role="status"
        class={cn(
          "tlib-undo-dirty inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/15 px-2 py-0.5 font-medium text-primary",
          props.class
        )}
      >
        {props.children ?? "Unsaved changes"}
      </span>
    </Show>
  );
};

export default UndoRedo;
