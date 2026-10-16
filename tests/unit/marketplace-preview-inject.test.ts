import { describe, expect, test } from "bun:test";
import { injectBeforeBodyEnd } from "../../shared/ts/marketplace/ui/preview-frame";

/**
 * The regression this file exists for: tRadio's marketplace cards rendered a
 * wall of black source text instead of the radio. tRadio's server injects a
 * theme script whose comment contains the literal `</body>`, the layouts are
 * fragments with no real body tag, and the card binder spliced itself into that
 * comment — ending the theme script early and dumping its remainder on screen.
 */

const BINDER = '<script id="binder">/* bound */</scr' + "ipt>";

describe("injectBeforeBodyEnd", () => {
  test("appends when the document is a fragment", () => {
    // What a real layout is: layouts/HLX-120G/ui.html has no html/head/body.
    const fragment = '<div class="radio"><span data-hud-text="ln01">CH 01</span></div>';
    expect(injectBeforeBodyEnd(fragment, BINDER)).toBe(fragment + BINDER);
  });

  test("splices before a real closing body tag", () => {
    const doc = "<html><body><div>x</div></body></html>";
    expect(injectBeforeBodyEnd(doc, BINDER)).toBe(
      `<html><body><div>x</div>${BINDER}</body></html>`
    );
  });

  test("ignores a closing body tag inside a script comment", () => {
    // The exact shape that broke: a comment mentioning </body> inside a script.
    const injected = ["<script>", "// injected before </body> by the panel.", "var S = 1;", "</scr" + "ipt>"].join(
      "\n"
    );
    const doc = injected + '<div class="radio"></div>';
    const out = injectBeforeBodyEnd(doc, BINDER);

    expect(out).toBe(doc + BINDER);
    // The binder must not land between the comment's `</body>` and what follows
    // it, which is what terminated the theme script early.
    expect(out).toContain("// injected before </body> by the panel.");
    expect(out.indexOf(BINDER)).toBeGreaterThan(out.indexOf('<div class="radio">'));
  });

  test("ignores a closing body tag inside an HTML comment", () => {
    const doc = '<!-- </body> --><div class="radio"></div>';
    expect(injectBeforeBodyEnd(doc, BINDER)).toBe(doc + BINDER);
  });

  test("prefers the real body tag over one quoted in a script", () => {
    const doc =
      "<html><body><script>var s = '</bo" +
      "dy>';</scr" +
      "ipt><div>x</div></body></html>";
    const out = injectBeforeBodyEnd(doc, BINDER);
    // Spliced at the real tag, so exactly one `</body>` follows the binder.
    expect(out.slice(out.indexOf(BINDER)).match(/<\/body>/gi)?.length).toBe(1);
    expect(out.endsWith("</body></html>")).toBe(true);
  });
});
