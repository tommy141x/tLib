import { createMemo, Repeat } from "solid-js";
import { t } from "./i18n";
import { formattedParts } from "./markup";

// The parser lives in markup.ts, which imports nothing. Re-exported here so every
// call site that has always said `from './text'` keeps working, and so the one
// consumer that must not pull in the translator -- the Playwright runner, which
// resolves through CommonJS -- can import './markup' directly instead.
export { formattedParts, plainText } from "./markup";

// <Repeat>, not <For>: formattedParts allocates fresh objects every call, so a reference
// diff never matches — part count is stable far more often than contents, so the span
// survives and only text/style get rewritten. <Repeat count> (Solid 2's index-addressed
// replacement for <Index each>) hands the child a plain number, so `part()` must be read
// through the `parts` memo each time, not snapshotted once, or the row freezes at its first
// value. White space is deliberately unset here — an inline pre-line once beat .row-label's
// nowrap and let a ~n~ grow a 38px row to 45-168px over the rows beneath; surfaces that want
// a break set pre-line in styles.css instead. Every rich-text surface routes through here, so
// translation happens in render and a 'menu:locale' push repaints without resending menus.
export function FormattedText(props: { text: string | undefined }) {
  const parts = createMemo(() => formattedParts(t(props.text)));
  return (
    <Repeat count={parts().length}>
      {(index) => {
        const part = () => parts()[index]!;
        return (
          <span
            style={{
              color: part().color,
              "font-style": part().italic ? "italic" : undefined,
              "font-weight": part().bold ? "700" : undefined,
            }}
          >
            {part().text}
          </span>
        );
      }}
    </Repeat>
  );
}
