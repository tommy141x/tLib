import { createMemo, Repeat } from "solid-js";
import { t } from "./i18n";
import { formattedParts } from "./markup";

// The parser lives in markup.ts, which imports nothing. Re-exported here so every
// call site that has always said `from './text'` keeps working, and so the one
// consumer that must not pull in the translator -- the Playwright runner, which
// resolves through CommonJS -- can import './markup' directly instead.
export { formattedParts, plainText } from "./markup";

// <Repeat>, not <For>: formattedParts allocates fresh objects every call, so a
// reference diff never matches and every description change rebuilt every span.
// The part count is stable far more often than the contents, so the span
// survives and only its text and style are written.
//
// <Repeat count> is Solid 2's replacement for Solid 1's <Index each>, and it is
// index-addressed rather than item-addressed: the child is handed a plain
// number, not an accessor. `parts` is therefore a memo and each read goes
// through `part()`, which is what keeps the text and style reactive while the
// span itself survives — doing `const p = parts()[index]` once in the child
// would snapshot it and freeze the row at its first value.
//
// White space is deliberately not set here. An inline style beats every
// stylesheet rule, so a hard-coded pre-line overrode .row-label's nowrap and let
// a ~n~ grow a fixed-height row's content to 45-168px inside a 38px box, over the
// rows beneath. The surfaces that do want a break ask for pre-line in styles.css,
// where the row can still say no.
//
// Every rich-text surface in the menu goes through here, which makes it the one
// place the wire's content can be translated. Doing it inside the render keeps
// the lookup reactive, so a 'menu:locale' push repaints without the game
// resending a single menu.
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
