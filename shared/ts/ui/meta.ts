/**
 * WHERE A COMPONENT GOES, AND WHY THIS RULE EXISTS
 *
 * This directory is THE component library. One kit, built on Ark UI, styled with
 * `cva` + the shared tokens, shared by every resource in the stack.
 *
 * The rule
 *
 *   1. A COMMON component goes here and nowhere else. A button, a card, an
 *      input, a select, a checkbox, a switch, a slider, a badge, a tab bar, a
 *      progress bar, a colour picker, a tooltip, a popover, a separator, a
 *      keycap, a field wrapper, a segmented control. If two resources would
 *      each need one, it is common -- it does not become resource-specific by
 *      being written in a resource first.
 *
 *   2. A GENUINELY resource-specific component stays local to that resource,
 *      and the file says, in prose, what makes it specific. Not "it needed
 *      different padding" -- that is a prop or a variant. Something structural
 *      that the shared component cannot express.
 *
 *   3. There is no third option. No parallel general-purpose kit, no adapter
 *      layer, no re-export shim. If the shared component is wrong, fix the
 *      shared component.
 *
 * Why it is written down
 *
 * Because its absence is measurable. tRadio, tDetector and tRadar each
 * hand-rolled buttons, inputs and panels rather than adopt either of the two
 * kits that already existed -- and the reason they could is that neither kit
 * said which one you were supposed to use, or when you were allowed to opt out.
 * A rule nobody wrote is a rule nobody can be shown to have broken.
 *
 * The one exception, and exactly how far it goes
 *
 * `shared/ts/nui-kit/` plus `tLib/client/web/src/components/ui/nui-controls.tsx`
 * are BARE controls: a checkbox box and a range input with theming and no
 * interaction behaviour of their own.
 *
 * They exist for one real constraint, and it is not a styling preference.
 * tLib's menu is server-authoritative and driven by keyboard and controller;
 * a menu row is a single `<button>` whose value only the row changes. Wrapping
 * that row in Ark's `Checkbox.Root` or `Slider.Root` nests a focusable element
 * inside a button: invalid content, and it breaks the navigation model
 * outright. So that one surface takes the rendered control and the theming and
 * keeps the interaction for itself.
 *
 * That justifies ONE SURFACE needing bare controls. It does not justify a
 * parallel general-purpose kit, and the two reasons once recorded for having
 * one do not survive contact:
 *
 *   - "Every token carries a fallback, so it renders in a host that defines no
 *     theme tokens." That is a bug described as a feature. A component should
 *     not carry a copy of the theme; the HOST should define the theme. The
 *     fallbacks stay for now only because tDetector and tRadar genuinely define
 *     no tokens today -- see the follow-up recorded at the top of
 *     `shared/ts/nui-kit/nui.css`.
 *   - "No icon set, because the three consumers have `unplugin-icons` but not
 *     `lucide-solid`." That is a dependency inconsistency to fix in those three
 *     projects, not a reason to fork a component library.
 *
 *     Half-closed, and the half that is closed is the half that was inside tLib:
 *     `client/web` had four `~icons/lucide` imports against seven files on the
 *     package, i.e. it was the fourth instance of this inconsistency and the
 *     only one nobody else owned. It is uniformly `lucide-solid/icons/*` now.
 *     `shared/ts/**` stays on `~icons/lucide` because that is the only form the
 *     three consumers can resolve, so the rule is "`~icons` in shared, the
 *     package in an app" — stated, in `client/web/src/components/MarketplacePanel.tsx`
 *     and on `NuiButton`. Adding `lucide-solid` to the three consumers and
 *     collapsing it to one form is still the end state; it is their change, not
 *     this file's.
 *
 * What is shared between the two, and what is not
 *
 * The MECHANISM, not the tokens. Focus in both kits is a border-colour shift
 * plus a real `outline` drawn inside the box -- never elevation, because CEF
 * cannot paint it and an elevation inside an `overflow: hidden` ancestor is
 * clipped to nothing. Kit A spells the colour `--ring`; nui-kit spells it
 * `--nui-accent-raw`. Both namespaces are deliberate and stay.
 *
 * The two NAMES stay; the two VALUES must not diverge, and they did. Kit A
 * painted `211 80% 55%` and nui-kit painted a neutral `0 0% 93%`, which is
 * visible to a player as the primary button changing colour when a tLib confirm
 * dialog opens over a tELS editor. Both are now `211 80% 55%`. The namespaces
 * exist so nui-kit resolves in a host that declares no tLib tokens at all --
 * that is a RESOLUTION concern, never a licence for a second palette.
 */
import type { Component } from "solid-js";

export interface ComponentMeta<_P = object> {
  name: string;
  description?: string;
  examples?: {
    title: string;
    description?: string;
    code: Component;
  }[];
}
