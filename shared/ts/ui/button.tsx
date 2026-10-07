import { Toggle as ArkToggle } from "@ark-ui/solid/toggle";
import { cn } from "@tlib/shared/cn";
import { cva } from "class-variance-authority";
// ⚠️ `ValidComponent` must come from `@solidjs/web`, NOT `solid-js`. Both packages
// export a type under that name and `solid-js`'s resolves fine, but it is
// `Component<any>` — function components only. `@solidjs/web`'s is the one that
// admits a tag name, which is what `as="button"` below needs, and it is also the
// constraint `dynamic()` itself is declared against.
import { dynamic, type JSX, type ValidComponent } from "@solidjs/web";
import type { Component } from "solid-js";
import { merge, omit, Show } from "solid-js";
import IconLoaderCircle from "~icons/lucide/loader-circle";

/**
 * Promoted verbatim from tELS's local `components/ui/button.tsx`. tELS is the
 * reference implementation and must keep rendering identically — its gallery is
 * the proof, and every class string below is byte-for-byte what it shipped.
 *
 * ── Why the cva lives HERE and not in a `button-variants.ts` ────────────────
 *
 * `select-variants.ts` sets the opposite-looking precedent, and following it was
 * tried first and measured to break the consumer. UnoCSS's default
 * `content.pipeline.include` is
 *
 *     /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/
 *
 * — `[jt]sx` matches `.jsx` and `.tsx`. A plain `.ts` file is NOT scanned, and no
 * config in this stack widens it. So a cva whose class strings live in a `.ts`
 * module contributes nothing to the generated stylesheet. Measured against tELS's
 * built CSS with the variants split out: 22 rules vanished, including `.h-10`,
 * `.h-9`, `.h-11`, `.size-8`, `.px-8`, `.!bg-primary`, every `hover:!bg-*` and
 * every `data-[pressed]:!bg-*`. The visible result was every Button losing its
 * height, which shifted whole panels up by 12px in 18 of 22 gallery shots.
 *
 * Nothing errors and no class is reported missing — `check:classes` looks for
 * dead classes, not absent ones — so this fails silently and only a screenshot
 * catches it.
 *
 * ⚠️ `select-variants.ts` has this defect TODAY: its arbitrary font sizes, its
 * min-width and its read-only data-variant are all absent from tELS's built CSS
 * both before and after this change. That is pre-existing and is left alone here
 * rather than fixed in passing, but it is why that file is not the pattern to
 * copy. The five other cva components in this kit (badge, kbd, card, progress,
 * separator) all keep theirs inline in the `.tsx`, which is both the majority
 * convention and the one that works.
 *
 * (Those class names are described rather than quoted on purpose — UnoCSS scans
 * this file's raw source, comments included, so writing one here emits a real,
 * dead CSS rule. Quoting the two from select-variants.ts added 80 bytes of dead
 * stylesheet to tELS before this note was reworded.)
 *
 * ── The `!` prefixes and `[background-image:none]` are deliberate ────────────
 *
 * Every background utility is `!`-important and the base carries an explicit
 * `[background-image:none]`. Both defend the same thing: this renders a bare
 * `<button>` (and, via `as`, an `<a>`), against Wind3's Tailwind-compat form
 * reset (`button { background-color: transparent; background-image: none }`)
 * plus whatever element-level `button { … }` rules a consumer's own stylesheet
 * adds after the utility layer — which is the shape every NUI bundle has.
 *
 * The history that would name the precise offending rule is not recoverable:
 * tELS's git history is a single squashed initial commit. These are therefore
 * preserved rather than rationalised away. Removing an `!` is an unmeasured
 * change to every consumer's rendering; if one ever goes, prove it with a
 * gallery shot, not with reasoning.
 *
 * ── Font sizes are NAMED (`text-sm`, `text-xs`) ─────────────────────────────
 *
 * `select-variants.ts` uses arbitrary sizes because its `density` axis has to
 * override its `size` axis, and `cn` keeps BOTH a named and an arbitrary text
 * size (`text-*` is ambiguous between font-size and colour, so unocss-merge will
 * not guess). Button has one size axis and no override to perform, so the named
 * utilities are correct and are what tELS shipped. If a second size axis is ever
 * added, read that file's note first.
 *
 * ── On `~icons/lucide/loader-circle` ────────────────────────────────────────
 *
 * That is an unplugin-icons virtual module, not a package: it resolves only in a
 * consumer whose vite config registers `Icons({ compiler: "solid" })` and whose
 * tsconfig lists `unplugin-icons/types/solid` in `types`.
 *
 * This is the kit's existing contract rather than a new demand — `select.tsx`
 * imports `~icons/lucide/check` and `~icons/lucide/chevron-down` the same way,
 * and `color-picker.tsx` likewise. A consumer lacking the plugin already cannot
 * build `select`, so `button` adds no requirement that was not there. Inlining an
 * SVG here instead would make this the one component in the kit drawing from a
 * different icon set from its siblings.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,text-decoration-color,fill,stroke,outline-color] outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:-outline-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [background-image:none]",
  {
    variants: {
      variant: {
        default:
          "!bg-primary text-primary-foreground hover:!bg-primary/90 data-[pressed]:!bg-primary/80",
        destructive:
          "!bg-destructive text-destructive-foreground hover:!bg-destructive/90 data-[pressed]:!bg-destructive/80",
        outline:
          "border border-input !bg-background text-foreground hover:!bg-accent hover:text-accent-foreground data-[pressed]:!bg-accent",
        secondary:
          "!bg-secondary text-secondary-foreground hover:!bg-secondary/80 data-[pressed]:!bg-secondary/70",
        ghost:
          "!bg-transparent text-foreground hover:!bg-accent hover:text-accent-foreground data-[pressed]:!bg-accent",
        link: "!bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3 text-xs",
        lg: "h-11 px-8",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonProps = {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  class?: string | undefined;
  children?: JSX.Element;
  toggle?: boolean;
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  // New props for loading state
  loading?: boolean;
  loadingText?: string;
  // Icons — pass as render functions so they are lazily evaluated inside
  // the Button's reactive render tree (avoids SSR/hydration mismatches).
  leftIcon?: () => JSX.Element;
  rightIcon?: () => JSX.Element;
  // Polymorphic as prop
  as?: ValidComponent;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "children"> & {
    /**
     * `data-*` must be spelled out, and this is NOT the old hole returning.
     *
     * TypeScript only exempts hyphenated attributes on INTRINSIC elements. On a
     * component the prop type has to admit them, so without this the six live
     * `data-*` call sites stop compiling — `data-hud-btn` among them, which is
     * the whole drag guard for hand-written tRadio skins.
     *
     * The value type is deliberately narrow rather than `unknown`: these end up
     * in `setAttribute`, and Solid 2 writes a boolean `true` as the EMPTY string
     * while removing the attribute on `false`. Admitting `object` here is how a
     * `classList={{…}}`-shaped mistake reaches the DOM as `[object Object]`.
     */
    [key: `data-${string}`]: string | number | boolean | undefined;
  };

const Button: Component<ButtonProps> = (props) => {
  const merged = merge(
    { variant: "default" as const, size: "default" as const, toggle: false },
    props
  );

  // `splitProps` returned three bags; `omit` returns only the last. Both picked
  // bags collapse into reading `merged` directly — note `merged`, NOT `props`:
  // the former `local.variant` / `local.size` / `local.toggle` were reading the
  // defaults applied above, and `props.variant` is `undefined` when a call site
  // omits it.
  const others = omit(
    merged,
    "variant",
    "size",
    "class",
    "toggle",
    "children",
    "loading",
    "loadingText",
    "leftIcon",
    "rightIcon",
    "disabled",
    "as",
    "pressed",
    "defaultPressed",
    "onPressedChange"
  );

  const isDisabled = () => !!(merged.disabled || merged.loading);

  // LeftIconSlot / RightIconSlot are tiny components defined inside Button so
  // they close over `local`. Defining them as named components (capital letter)
  // means SolidJS treats them as reactive nodes in the render tree — they
  // re-run when `merged.loading` or `merged.leftIcon` / `merged.rightIcon` change,
  // rather than being evaluated once and baked into a static JSX snapshot.
  // This is the correct pattern to avoid "template is not a function" hydration
  // errors that occur when bare ternaries or called helper-functions are used.
  const LeftIconSlot: Component = () => {
    if (merged.loading || !merged.leftIcon) return null;
    return <>{merged.leftIcon()}</>;
  };

  const RightIconSlot: Component = () => {
    if (merged.loading || !merged.rightIcon) return null;
    return <>{merged.rightIcon()}</>;
  };

  // innerContent is assigned as a JSX value (not called as a function), so it
  // lives permanently inside SolidJS's reactive tree. Each Show / component
  // node re-evaluates independently when its signals change.
  const innerContent: JSX.Element = (
    <>
      <Show when={merged.loading}>
        <IconLoaderCircle class="h-4 w-4 animate-spin" />
      </Show>
      <LeftIconSlot />
      <Show when={merged.loading && merged.loadingText} fallback={merged.children}>
        {merged.loadingText}
      </Show>
      <RightIconSlot />
    </>
  );

  if (merged.toggle) {
    return (
      <ArkToggle.Root
        pressed={merged.pressed as unknown as boolean | undefined}
        defaultPressed={merged.defaultPressed as unknown as boolean | undefined}
        onPressedChange={merged.onPressedChange}
        disabled={isDisabled()}
        class={cn(buttonVariants({ variant: merged.variant, size: merged.size }), merged.class)}
        {...others}
      >
        {innerContent}
      </ArkToggle.Root>
    );
  }

  // For polymorphic rendering without 'as' prop, use regular button
  if (!merged.as) {
    return (
      <button
        disabled={isDisabled()}
        class={cn(buttonVariants({ variant: merged.variant, size: merged.size }), merged.class)}
        {...others}
      >
        {innerContent}
      </button>
    );
  }

  // For polymorphic rendering with 'as' prop, use `dynamic()`.
  // `<Dynamic>` still exists but is deprecated; `dynamic()` is the factory form
  // and is called ONCE per component instance rather than per render — it
  // memoises on the source, so hoisting it is the whole point of the new API.
  // `merged.as` stays inside the getter, so the tag is still reactive.
  // Don't pass disabled to non-button elements (like anchor tags)
  const isNativeButton = merged.as === "button";
  const extraProps = isNativeButton ? { disabled: isDisabled() } : {};
  const As = dynamic(() => merged.as as ValidComponent);

  return (
    <As
      class={cn(buttonVariants({ variant: merged.variant, size: merged.size }), merged.class)}
      {...extraProps}
      {...others}
    >
      {innerContent}
    </As>
  );
};

export type { ButtonProps };
export { Button, buttonVariants };
export default Button;
