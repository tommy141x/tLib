/**
 * The three ways unsanitised data could blank a Stream Deck key.
 *
 * Every string these keys draw that a human typed arrives unvalidated — a
 * channel name out of a codeplug, a talker's name off a loopback socket, a unit
 * callsign. The shared render layer escapes the five markup characters and
 * stopped there, and the failure mode of what it did not handle is TOTAL: an
 * SVG carrying one C0 control or one lone surrogate does not parse, so the host
 * draws an EMPTY key rather than a key with an odd character on it. Nothing in
 * the gallery catches that, because the gallery draws the strings the products
 * were designed around.
 *
 * All three cases are reachable from a real player name — FiveM names carry
 * emoji routinely, which is what makes the truncation case the likely one
 * rather than the theoretical one.
 *
 * Each test states what the broken version produced, so the assertion is about
 * a defect rather than about a preference.
 */

import { describe, expect, test } from "bun:test";
import { bindKey, LCD_MATERIAL } from "../../shared/ts/deck/material.ts";
import { esc, truncateToWidth } from "../../shared/ts/deck/metrics.ts";

const K = bindKey(LCD_MATERIAL, { accent: "#8298a8" });

/** Any lone surrogate left in a string, as a list of code units. */
function loneSurrogates(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const high = c >= 0xd800 && c <= 0xdbff;
    const low = c >= 0xdc00 && c <= 0xdfff;
    if (high) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else out.push(c);
    } else if (low) {
      out.push(c);
    }
  }
  return out;
}

describe("esc: XML-illegal input cannot reach the document", () => {
  test("the five markup characters are still escaped", () => {
    expect(esc(`<a & b> "q"`)).toBe("&lt;a &amp; b&gt; &quot;q&quot;");
  });

  test("C0 controls are removed, not passed through", () => {
    // A NUL or a BEL anywhere in an SVG makes the whole document unparseable,
    // so this one character used to cost the entire key rather than itself.
    const drawn = esc("UNIT\u00001\u0007A\u001B");
    expect(drawn).toBe("UNIT1A");
  });

  test("tab, newline and carriage return are left alone", () => {
    // Legal XML, and these primitives draw single lines — so they render as
    // nothing rather than as damage, and stripping them would be a different
    // (unasked-for) change to how long strings measure.
    expect(esc("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  test("a lone surrogate is removed and a real pair survives", () => {
    expect(esc("hi\uD83D")).toBe("hi");
    expect(esc("\uDE00hi")).toBe("hi");
    expect(esc("hi\u{1F600}")).toBe("hi\u{1F600}");
  });

  test("the noncharacters U+FFFE/U+FFFF are removed", () => {
    expect(esc("a￾b￿c")).toBe("abc");
  });
});

describe("truncateToWidth: a cut never splits a surrogate pair", () => {
  // Emoji at every offset, so the binary search is forced to land mid-pair for
  // some width. A bare `slice` left the high half behind — a lone surrogate,
  // illegal XML, blank key — and the name that triggered it looked completely
  // ordinary in a log.
  const names = [
    "\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}\u{1F605}",
    "Dave \u{1F694} Unit 12 \u{1F693} Patrol",
    "\u{1F1FA}\u{1F1F8} Officer \u{1F46E} Smith",
  ];

  test("no truncation at any width leaves a lone surrogate", () => {
    for (const name of names) {
      for (let maxWidth = 1; maxWidth <= 160; maxWidth += 1) {
        const cut = truncateToWidth(name, 20, maxWidth, 700, 0);
        expect(loneSurrogates(cut)).toEqual([]);
      }
    }
  });

  test("and the result still survives escaping intact", () => {
    for (const name of names) {
      for (let maxWidth = 1; maxWidth <= 160; maxWidth += 4) {
        expect(loneSurrogates(esc(truncateToWidth(name, 20, maxWidth, 700, 0)))).toEqual([]);
      }
    }
  });

  test("plain text truncation is unchanged", () => {
    expect(truncateToWidth("DISPATCH CHANNEL", 14, 40, 700, 0)).toBe("DISP…");
    expect(truncateToWidth("", 14, 40, 700, 0)).toBe("");
  });
});

describe("card: a non-finite signal draws no meter", () => {
  const theme = K.theme();

  test("a real level draws the meter", () => {
    const withMeter = K.card(theme, { signal: 3, glyphs: [{ text: "S", on: true }] });
    const none = K.card(theme, { glyphs: [{ text: "S", on: true }] });
    expect(withMeter).not.toBe(none);
  });

  test("NaN draws exactly what no signal draws", () => {
    // `Number(snapshot.signal)` is how all three products derive this, and
    // `Number("c")` is NaN — a number, so a bare `typeof` check drew a meter
    // with every bar unlit AND took the width back off the flag chips. Two
    // wrong things from one bad field; no meter is the honest answer.
    const nan = K.card(theme, { signal: Number("c"), glyphs: [{ text: "S", on: true }] });
    const none = K.card(theme, { glyphs: [{ text: "S", on: true }] });
    expect(nan).toBe(none);
  });

  test("zero is a real level and still draws the meter", () => {
    // The guard must not swallow 0: a radio reporting no bars is a reading, and
    // `DisplayState.signal` has a documented "0" that layout icon sets ship.
    const zero = K.card(theme, { signal: 0, glyphs: [{ text: "S", on: true }] });
    const none = K.card(theme, { glyphs: [{ text: "S", on: true }] });
    expect(zero).not.toBe(none);
  });
});
