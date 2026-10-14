/**
 * DELIBERATELY-BROKEN CONTROL for `scripts/solid2-scan.ts`.
 *
 * This file is NOT compiled, NOT exported and NOT part of any bundle. It is a
 * fixture that is still written in Solid 1, on purpose, and it must keep
 * tripping every rule the scanner owns.
 *
 * Why it exists: a scanner whose pattern drifts reports zero findings, and zero
 * findings is indistinguishable from "the migration is finished". That has bitten
 * this codebase twice (a scraper that matched no rows and compared two empty
 * arrays green for weeks; two mutants scored "survived" because the substitution
 * never applied). So the scanner runs over this file too, and the run FAILS if
 * any single rule stops matching here — even when the real tree is clean.
 *
 * Do not migrate this file. Do not add it to a tsconfig include. If a rule is
 * retired from the scanner, delete its case here in the same commit.
 */

// rule: solid1-type-moved  (JSX and ValidComponent belong to @solidjs/web now)
import type { Component, JSX, ValidComponent } from "solid-js";
// rule: solid1-import-removed  (onMount, mergeProps, splitProps, on, Index)
import {
  createEffect,
  createSignal,
  Index,
  mergeProps,
  on,
  onCleanup,
  onMount,
  splitProps,
} from "solid-js";
// rule: solid1-store-import
import { createStore } from "solid-js/store";
// rule: solid1-web-import
import { Dynamic, Portal } from "solid-js/web";

type ControlState = { open: boolean; label: string };

const [controlState, setControlState] = createStore<ControlState>({ open: false, label: "" });

export const Solid2ScanControl: Component<{
  class?: string;
  items: string[];
  as?: ValidComponent;
  label?: JSX.Element;
}> = (rawProps) => {
  const props = mergeProps({ class: "" }, rawProps);
  const [local, others] = splitProps(props, ["class"]);
  const [ready, setReady] = createSignal(false);

  // rule: cleanup-in-mount
  onMount(() => {
    const id = setInterval(() => setReady(true), 1000);
    onCleanup(() => clearInterval(id));
  });

  // rule: createEffect-on
  createEffect(
    on(
      () => controlState.open,
      (open) => setReady(open)
    )
  );

  // rule: store-path-setter  (path form and whole-object merge form)
  setControlState("open", true);
  setControlState({ open: false, label: "control" });

  return (
    <Dynamic component="div" class={local.class} {...others}>
      <Portal>
        <Index each={rawProps.items}>{(item) => <span>{item()}</span>}</Index>
      </Portal>
      {ready() ? controlState.label : null}
    </Dynamic>
  );
};
