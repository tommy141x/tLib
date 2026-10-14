/**
 * The negative control's defect table — DATA ONLY, no side effects. Its own
 * module because `scripts/dom-control.ts` reads it and importing `_setup.ts`
 * would run the whole preload.
 *
 * A substitution that matches nothing hands the suite the UNMODIFIED module, so
 * every entry declares its match `count` and a miscount is exit 2. A passing
 * control proves the assertion still fires; it does NOT prove the rule set is
 * complete, which is why every entry names the `path` it travels.
 *
 * What each entry proves, and what it cannot:
 * docs/internal/dom-control-defects.md
 */

// The negative control: planting a defect in the REAL source, in memory, on its
// way through the loader. Nothing is written to disk.
//
//
export interface Defect {
  /** The file, relative to the repo root. */
  file: string;
  find: string;
  replace: string;
  /** How many times `find` must occur. Not a guess — measured. */
  count: number;
  /** Which test names must go red. Asserted by `scripts/dom-control.ts`. */
  reddens: string[];
  /** Total tests failing -- the blast radius. A count, not names, because one
   *  defect in a shared path legitimately cascades, and a control coupled to
   *  fourteen sentences is one that gets edited until it passes. Measured. */
  total: number;
  /** The path the defect travels, so a control that cannot reach it is visible. */
  path: string;
}

export const DEFECTS: Record<string, Defect> = {
  "ungated-cancel": {
    file: "shared/ts/prop-editor/PropEditor.tsx",
    find: "if (history.isDirty()) {",
    replace: "if (false) {",
    count: 1,
    total: 14,
    path: "real window keydown -> escape registry -> onEscape -> requestCancel -> the gate",
    reddens: [
      "Escape asks instead of discarding when the session is dirty",
      "Cancel routes through the guard rather than discarding",
      "the prompt is an alertdialog with both answers in it",
      "a dirty session's Escape sends no propEditorCancel",
    ],
  },
  "escape-cannot-dismiss": {
    file: "shared/ts/prop-editor/PropEditor.tsx",
    find: "        setDiscarding(false);\n        return true;",
    replace: "        return true;",
    count: 1,
    total: 1,
    path: "real window keydown with the prompt UP -> escape registry -> onInternal",
    reddens: ["onInternal dismisses the prompt before the escape layer can act"],
  },
  "no-keep-focus": {
    file: "shared/ts/prop-editor/PropEditor.tsx",
    find: "ref={(el: HTMLButtonElement) => queueMicrotask(() => el.focus())}",
    replace: "ref={(_el: HTMLButtonElement) => void 0}",
    count: 1,
    total: 1,
    path: "the prompt's own ref callback, after a microtask drain",
    reddens: ["focus lands on Keep editing, not on the destructive answer"],
  },
  "undo-depth-zero": {
    file: "shared/ts/prop-editor/PropEditor.tsx",
    find: "      depth: 1,\n      history,",
    replace: "      depth: 0,\n      history,",
    count: 1,
    total: 1,
    path: "real window keydown -> undo-key registry resolve() against a host scope",
    /* `depth 1 beats a host page's scope` is deliberately NOT in this list: it
     * registers the host scope first, so the newest-first tie-break made the
     * editor win anyway and the control reddened nothing. */
    reddens: ["depth 1 holds even when the host registers its scope LAST"],
  },
  "no-blur-commit": {
    file: "shared/ts/prop-editor/PropEditor.tsx",
    find: "onCommit={() => history.commit()}",
    replace: "onCommit={undefined}",
    count: 3,
    total: 2,
    path: "a real blur event on a real number input -> PropField.onBlur -> commit",
    reddens: ["a number field's blur commits its open batch"],
  },
  "layout-discard-order": {
    file: "client/web/src/layout/LayoutEditor.tsx",
    find: 'data-discard-answer="keep"',
    replace: 'data-discard-answer="discard"',
    count: 1,
    total: 1,
    path: "the rendered footer of LayoutEditor's own discard prompt",
    reddens: ["the lossy answer is on the RIGHT and the safe one takes the affirmative slot"],
  },
  /** The largest blast radius in the table, and that is the finding: Solid 1's
   *  boolean arg lands in Solid 2's `skip` predicate, which throws in a render
   *  effect, and Solid 2 halts the reactive graph for the WHOLE PROCESS. */
  "spread-arity-verbatim": {
    file: "shared/ts/solid-compat/solid-1-compat-web.ts",
    find: "return (realSpread as any)(node, accessor, skipChildren);",
    replace: "return (realSpread as any)(node, accessor, ...rest);",
    count: 1,
    total: 54,
    path: "lucide-solid/dist/esm/Icon.mjs:37 -> the rewritten `solid-js/web` -> this shim's spread -> real @solidjs/web spread -> collectProps' skip(prop)",
    reddens: [
      "renders an <svg> in the SVG namespace, not an empty container",
      "carries the attributes `spread` is the only thing that applies",
      "has real child geometry, not just an empty <svg>",
      "children are rendered ONCE — a dropped skipChildren duplicates them",
      "stays reactive — the graph was not halted",
      "Solid 1's arg 3 (isSVG) is DROPPED, not read as skipChildren",
      "Solid 1's arg 4 becomes Solid 2's arg 3 (skipChildren)",
    ],
  },
  /** Travels two paths: the trigger through `cn` (shielded) and a target row's
   *  raw class attribute. It cannot prove unoMerge would eat the colour without
   *  the shield -- happy-dom sees the string, not the stylesheet. */
  "export-positive-outline-offset": {
    file: "shared/ts/ui/export-badge.tsx",
    find: "focus-visible:-outline-offset-1",
    replace: "focus-visible:outline-offset-1",
    count: 1,
    total: 2,
    path: "the FOCUS_RING constant -> PopoverTrigger -> cn() (shielded) AND -> a target row's raw class attribute (unshielded)",
    reddens: [
      "the trigger has one — it did not before, in EITHER resource",
      "every target row has one — neither copy did",
    ],
  },
  /** Reaches the CLOSING half only. zag's dismissable layer preventDefaults the
   *  keydown whether or not `closeOnEscape` is set, so the registry stand-down
   *  cannot be reddened from here and is asserted rather than guarded. */
  "export-ark-escape-off": {
    file: "shared/ts/ui/export-badge.tsx",
    find: "        closeOnEscape\n",
    replace: "        closeOnEscape={false}\n",
    count: 1,
    total: 1,
    path: "real window keydown -> zag dismissable (document listener) -> closeOnEscape -> the popover's own open state",
    reddens: ["a press while the picker is open closes the picker"],
  },
  /** The one irreversible action: confirming moves a config out of the resource
   *  that owns it. Both copies gated it and neither had a test saying so. */
  "export-unconfirmed": {
    file: "shared/ts/ui/export-badge.tsx",
    find: "onClick={() => setConfirming(target.name)}",
    replace: "onClick={() => doExport(target.name)}",
    count: 1,
    total: 6,
    path: "a real click on a real target row -> the row's own onClick -> onExport",
    reddens: ["choosing a target asks rather than exporting"],
  },
  /** THE BROKEN-GATE DRILL. `find` cannot occur, so this must make the preload
   *  THROW -- otherwise "every defect reddened something" is not evidence the
   *  patcher fired at all. */
  "drill-cannot-match": {
    file: "shared/ts/prop-editor/PropEditor.tsx",
    find: "this string is not in the file",
    replace: "nor is this",
    count: 1,
    total: 0,
    path: "none — deliberately unmatched",
    reddens: [],
  },
};

export const DOM_CONTROL_DEFECTS = DEFECTS;
