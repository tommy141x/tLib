/**
 * The shared `ui` content contract.
 *
 * `uiLayoutContract` is the floor every product's layout install is gated by.
 * Three of the four consumers had NO contract before it existed — tDetector,
 * tRadar and tELS — so a bundle with no `ui.html`, or with an `install.lua` in
 * it, installed with a success and went wrong later on a player's machine.
 *
 * The half of this file that matters most is `the shipped corpus still installs`:
 * a gate that refuses a layout which would have rendered is worse than no gate,
 * so the directory listings of all ten shipped layouts are asserted to pass. They
 * are fixtures rather than a `readdir` of the sibling resources because tLib is
 * published on its own and must test without them on disk — the lists were
 * measured from the tree on 2026-10-15.
 *
 * Pure, so it is tested directly rather than through an install.
 */

import { describe, expect, test } from "bun:test";
import {
  type PreparedPayload,
  UI_LAYOUT_ALLOWED_EXTS,
  uiLayoutContract,
} from "../../shared/ts/marketplace/installer";

const validate = uiLayoutContract();

function payload(names: readonly string[], opts: { zip?: boolean; slug?: string } = {}) {
  return {
    type: "ui",
    slug: opts.slug ?? "tdet-rdx-4000",
    zip: opts.zip ?? true,
    files: new Map(names.map((name) => [name, Buffer.from("x")])),
  } satisfies PreparedPayload;
}

/** Measured 2026-10-15 from `<resource>/layouts/<name>/`. */
const SHIPPED_CORPUS: Record<string, readonly string[]> = {
  "tDetector/ARC-360": [
    "ui.html",
    "module.json",
    "chassis.png",
    "led_front.png",
    "led_front_l.png",
    "led_front_r.png",
    "led_left.png",
    "led_rear.png",
    "led_rear_l.png",
    "led_rear_r.png",
    "led_right.png",
  ],
  "tDetector/RDX-4000": ["ui.html", "module.json", "chassis.png"],
  "tDetector/RDX-8000": ["ui.html", "module.json", "chassis.png"],
  "tRadar/CHX-800": ["ui.html", "module.json", "chassis.png"],
  "tRadar/KBX-2200": ["ui.html", "module.json", "chassis.png"],
  "tRadar/PRX-400": ["ui.html", "module.json", "chassis.png"],
  "tRadar/RCX-150": ["ui.html", "module.json", "chassis.png"],
  "tRadar/SLX-1100": ["ui.html", "module.json", "chassis.png"],
  // The one that nests its artwork, which is why the allow-list is tested
  // against a PATH and not against a basename.
  "tELS/WCC": [
    "ui.html",
    "module.json",
    "icons/arrow.png",
    "icons/btn.png",
    "icons/headlight.png",
    "icons/knob.png",
    "icons/lev1.png",
    "icons/panel.png",
    "icons/reference.png",
  ],
  "tELS/WCC2": [
    "ui.html",
    "module.json",
    "btn.png",
    "lev1.png",
    "lev2.png",
    "lev3.png",
    "lev4.png",
    "panel.png",
  ],
};

describe("the shipped corpus still installs", () => {
  test.each(Object.entries(SHIPPED_CORPUS))("%s", (_name, names) => {
    expect(() => validate(payload(names))).not.toThrow();
  });
});

describe("accepts", () => {
  test("a bare document, because that is a whole layout", () => {
    expect(() => validate(payload(["ui.html"]))).not.toThrow();
  });

  test("inline script inside ui.html", () => {
    // Load-bearing for tELS: both of its shipped layouts drive themselves from a
    // function the preview calls by name. What the allow-list refuses is a
    // separate executable FILE, and the document's CONTENTS are not inspected by
    // the floor at all.
    const bundle = payload(["ui.html"]);
    bundle.files.set("ui.html", Buffer.from("<script>window.x=1</script>"));
    expect(() => validate(bundle)).not.toThrow();
  });

  test("a layout that declares no canvas", () => {
    // Deliberately NOT refused here. The attribute family is per-product
    // (`data-radio-*` vs `data-radar-*`) and `ui/preview-canvas.ts` has a
    // fallback tier, so an undeclared canvas is a mis-scale, not a dead layout.
    // Requiring it of everyone would refuse every tRadar layout.
    const bundle = payload(["ui.html"]);
    bundle.files.set("ui.html", Buffer.from("<div class=radar></div>"));
    expect(() => validate(bundle)).not.toThrow();
  });
});

describe("refuses", () => {
  test("a raw, non-archive bundle", () => {
    // A single unnamed file is meaningful for a sound and never for a layout.
    expect(() => validate(payload([""], { zip: false }))).toThrow(/not an archive/);
  });

  test("an archive with no ui.html", () => {
    expect(() => validate(payload(["chassis.png"]))).toThrow(/no ui\.html/);
  });

  test("ui.html nested in a subdirectory, which no consumer would find", () => {
    // Every reader asks for the literal path: `prepareBundle`'s studio-comment
    // strip, and each consumer's `layouts/<name>/ui.html`.
    expect(() => validate(payload(["skin/ui.html"]))).toThrow(/no ui\.html/);
  });

  test("a differently-cased UI.HTML, for the same reason", () => {
    expect(() => validate(payload(["UI.HTML"]))).toThrow(/no ui\.html/);
  });

  test("an executable file beside the document", () => {
    expect(() => validate(payload(["ui.html", "install.lua"]))).toThrow(
      /may not ship.*install\.lua/s
    );
  });

  test("an extensionless file", () => {
    expect(() => validate(payload(["ui.html", "README"]))).toThrow(/may not ship/);
  });

  test("every problem at once, rather than only the first", () => {
    // An operator fixing a broken layout should not have to install it twice to
    // find two faults.
    const error = (() => {
      try {
        validate(payload(["evil.js"]));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain("may not ship");
    expect(error?.message).toContain("no ui.html");
    // Names the item, so a multi-install batch says which one failed.
    expect(error?.message).toContain("tdet-rdx-4000");
  });

  test("a long list of bad files is summarised, not dumped", () => {
    const names = ["ui.html", ...Array.from({ length: 9 }, (_, i) => `bad${i}.js`)];
    expect(() => validate(payload(names))).toThrow(/and 4 more/);
  });
});

describe("the checkDocument seam", () => {
  test("a product's own problems are carried through verbatim", () => {
    const strict = uiLayoutContract({
      checkDocument: (html) => (html.includes("data-radio-width") ? [] : ["needs a width"]),
    });
    expect(() => strict(payload(["ui.html"]))).toThrow(/needs a width/);
  });

  test("it is not consulted when the document is absent", () => {
    // Otherwise a product's rule is handed an empty string and reports its own
    // problem on top of "there is no document", which buries the real one.
    let called = false;
    const strict = uiLayoutContract({
      checkDocument: () => {
        called = true;
        return ["unreachable"];
      },
    });
    expect(() => strict(payload(["chassis.png"]))).toThrow(/no ui\.html/);
    expect(called).toBe(false);
  });
});

describe("UI_LAYOUT_ALLOWED_EXTS", () => {
  test.each([
    "a.html",
    "a.css",
    "a.json",
    "a.png",
    "a.JPG",
    "a.jpeg",
    "a.gif",
    "a.svg",
    "a.webp",
    "a.wav",
    "a.ogg",
    "a.otf",
    "a.ttf",
    "a.woff",
    "a.woff2",
  ])("allows %s", (name) => {
    expect(UI_LAYOUT_ALLOWED_EXTS.test(name)).toBe(true);
  });

  test.each(["a.js", "a.mjs", "a.lua", "a.exe", "a.dll", "a.sh", "a.zip", "a.html.js", "a"])(
    "blocks %s",
    (name) => {
      expect(UI_LAYOUT_ALLOWED_EXTS.test(name)).toBe(false);
    }
  );

  test("anchored to the END, so a double extension cannot smuggle one past", () => {
    expect(UI_LAYOUT_ALLOWED_EXTS.test("skin.png.lua")).toBe(false);
    expect(UI_LAYOUT_ALLOWED_EXTS.test("skin.lua.png")).toBe(true);
  });
});
