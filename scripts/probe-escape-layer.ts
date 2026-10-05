/**
 * Press a real Escape key at the real escape registry, in a real browser.
 *
 *   bun run probe:escape
 *
 * The unit suite in `tests/unit/escape-layer.test.ts` drives the registry
 * through a hand-written event target, because there is no DOM in that runner.
 * That harness asserts the registry's *decisions*, and it cannot assert the one
 * thing those decisions rest on: that a capture listener on `window` really does
 * run before a bubble listener on `window`, for a real `KeyboardEvent`, with
 * real `defaultPrevented` propagation and real `repeat` on a held key. If that
 * ordering were wrong the whole sample-then-decide design would be wrong, and
 * every harness assertion would still pass.
 *
 * So this bundles the real module, serves it, and presses keys with Playwright.
 * It covers the primitive only — a consumer's own wiring (which layer, what
 * depth, which `active`) is not exercised here and must not be claimed as such.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const scratch = await mkdtemp(resolve(tmpdir(), "tlib-escape-probe-"));
const entry = resolve(scratch, "entry.ts");

// The probe's page script. It imports the REAL module by path, so there is no
// second implementation to drift.
await Bun.write(
  entry,
  `import { EscapeLayerRegistry } from ${JSON.stringify(resolve(import.meta.dir, "../shared/ts/escape-layer.ts"))};

declare global {
  interface Window {
    probe: {
      fired: string[];
      preventedEarly: boolean[];
      preventedLate: boolean[];
      reset(): void;
      scenario(name: string): void;
    };
  }
}

const registry = new EscapeLayerRegistry(window as never);
const fired: string[] = [];
// Registered before the registry attaches, so it runs BEFORE the registry's own
// bubble listener and must still see an untouched event.
const preventedEarly: boolean[] = [];
const preventedLate: boolean[] = [];
let disposers: (() => void)[] = [];

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") preventedEarly.push(event.defaultPrevented);
});

function reset() {
  for (const dispose of disposers) dispose();
  disposers = [];
  fired.length = 0;
  preventedEarly.length = 0;
  preventedLate.length = 0;
  registry.reset();
}

function scenario(name: string) {
  reset();
  const late = (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape")
      preventedLate.push(event.defaultPrevented);
  };
  if (name === "stacked") {
    disposers.push(
      registry.add({ label: "editor", depth: 0, onEscape: () => fired.push("editor") })
    );
    disposers.push(
      registry.add({ label: "modal", depth: 1, onEscape: () => fired.push("modal") })
    );
  } else if (name === "split-phase") {
    // The tRadio shape: a panel that closes on keydown over a focus release
    // that happens on keyup.
    let open = true;
    const panel = registry.add({
      label: "panel",
      depth: 1,
      active: () => open,
      onEscape: () => {
        open = false;
        fired.push("panel");
        panel();
      },
    });
    disposers.push(panel);
    disposers.push(
      registry.add({
        label: "radio",
        depth: 0,
        phase: "keyup",
        onEscape: () => fired.push("radio"),
      })
    );
  } else if (name === "internal-first") {
    let preview = true;
    disposers.push(
      registry.add({
        label: "browser",
        onInternal: () => {
          if (!preview) return false;
          preview = false;
          fired.push("preview");
          return true;
        },
        onEscape: () => fired.push("browser"),
      })
    );
  } else if (name === "guarded-by-ark") {
    // A real third-party handler that owns Escape and says so the way the DOM
    // says it: by calling preventDefault in a listener of its own.
    const ark = document.getElementById("ark")!;
    ark.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") event.preventDefault();
    });
    disposers.push(
      registry.add({ label: "editor", depth: 0, onEscape: () => fired.push("editor") })
    );
    ark.focus();
  } else if (name === "typing") {
    disposers.push(
      registry.add({
        label: "editor",
        ignoreWhenTyping: true,
        onEscape: () => fired.push("editor"),
      })
    );
  } else {
    throw new Error("unknown scenario " + name);
  }
  // Registered last, so it runs after the registry's bubble listener.
  window.addEventListener("keydown", late, false);
  disposers.push(() => window.removeEventListener("keydown", late, false));
}

window.probe = { fired, preventedEarly, preventedLate, reset, scenario };
`
);

const bundle = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
if (!bundle.success) {
  console.error(bundle.logs.join("\n"));
  process.exit(1);
}
const script = await bundle.outputs[0].text();

const html = `<!doctype html><html><body>
<div id="ark" tabindex="0">ark-like overlay</div>
<input id="field" />
<script type="module">${script}</script>
</body></html>`;

const server = Bun.serve({
  port: 0,
  fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
});

const failures: string[] = [];
function check(ok: boolean, message: string) {
  if (ok) console.log(`PASS ${message}`);
  else {
    failures.push(message);
    console.log(`FAIL ${message}`);
  }
}

try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.port}/`);
  await page.waitForFunction("!!window.probe");

  const run = async (scenario: string, keys: () => Promise<void>) => {
    await page.evaluate((name) => window.probe.scenario(name), scenario);
    await keys();
    return page.evaluate(() => ({
      fired: [...window.probe.fired],
      preventedEarly: [...window.probe.preventedEarly],
      preventedLate: [...window.probe.preventedLate],
    }));
  };

  // 1. Stacking, with a real key.
  let result = await run("stacked", () => page.keyboard.press("Escape"));
  check(
    JSON.stringify(result.fired) === JSON.stringify(["modal"]),
    `a real Escape press is taken by the topmost layer (got ${JSON.stringify(result.fired)})`
  );

  // 2. The ordering the whole design rests on, measured from both sides. A
  // bubble listener on `window` registered AFTER the registry sees the press
  // already handled; one registered BEFORE it does not, because same-node
  // listeners fire in registration order and `preventDefault` is all the
  // registry does.
  //
  // That asymmetry is not a defect, it is the reason the registry does not try
  // `stopPropagation`: on `window`'s bubble phase there is nothing left to stop,
  // and a handler that ran earlier cannot be unrun. It is also exactly why the
  // three resources that bound Escape themselves had to use capture phase to
  // out-race each other — and why routing them all through one registry is what
  // actually removes the race rather than moving it.
  check(
    result.preventedLate.length === 1 && result.preventedLate[0] === true,
    `a later window listener sees the press already handled (got ${JSON.stringify(result.preventedLate)})`
  );
  check(
    result.preventedEarly.length === 1 && result.preventedEarly[0] === false,
    `an earlier window listener still sees it live, as the DOM requires (got ${JSON.stringify(result.preventedEarly)})`
  );

  // 3. One press, one dismissal, across both halves of the key.
  result = await run("split-phase", () => page.keyboard.press("Escape"));
  check(
    JSON.stringify(result.fired) === JSON.stringify(["panel"]),
    `one real press dismisses one layer even when the halves differ (got ${JSON.stringify(result.fired)})`
  );

  // 4. A genuinely held key. Playwright's `down` without `up` produces real
  // repeats only if the platform generates them, so assert the invariant that
  // holds either way: no more than one dismissal.
  result = await run("split-phase", async () => {
    await page.keyboard.down("Escape");
    await page.waitForTimeout(600);
    await page.keyboard.up("Escape");
  });
  check(
    JSON.stringify(result.fired) === JSON.stringify(["panel"]),
    `holding Escape is one press, not one per repeat (got ${JSON.stringify(result.fired)})`
  );

  // 5. Internal layer first.
  result = await run("internal-first", async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });
  check(
    JSON.stringify(result.fired) === JSON.stringify(["preview", "browser"]),
    `two real presses close the inner layer then the outer (got ${JSON.stringify(result.fired)})`
  );

  // 6. A third-party handler that calls preventDefault wins, in both phases.
  result = await run("guarded-by-ark", () => page.keyboard.press("Escape"));
  check(
    result.fired.length === 0,
    `a real preventDefault from another listener keeps the key (got ${JSON.stringify(result.fired)})`
  );

  // 7. ignoreWhenTyping against a real focused input.
  result = await run("typing", async () => {
    await page.locator("#field").focus();
    await page.keyboard.press("Escape");
  });
  check(
    result.fired.length === 0,
    `ignoreWhenTyping stands down in a real focused input (got ${JSON.stringify(result.fired)})`
  );
  result = await run("typing", async () => {
    await page.locator("#field").blur();
    await page.keyboard.press("Escape");
  });
  check(
    JSON.stringify(result.fired) === JSON.stringify(["editor"]),
    `and acts once focus leaves it (got ${JSON.stringify(result.fired)})`
  );

  await browser.close();
} finally {
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} real-browser Escape check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: the escape registry, exercised with real key presses in Chromium");
