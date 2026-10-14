import { afterEach, describe, expect, test } from "bun:test";
import { badGatewayPage, escapeHtml, notFoundPage, renderError, renderIndex } from "./hub";
import { clear, type Mount, register } from "./registry";

const app = (over: Partial<Mount> = {}): Mount =>
  ({
    kind: "inprocess",
    id: "dispatch",
    mount: "/dispatch",
    title: "Dispatch",
    listed: true,
    resourceName: "tRadio",
    ...over,
  }) as Mount;

afterEach(clear);

describe("hub", () => {
  test("only lists public mounts, including when passed an unfiltered registry", () => {
    const mounts = [app(), app({ listed: false, mount: "/secret", title: "Secret" })];
    const html = renderIndex(mounts, "305 RP");
    expect(html).toContain("1 destination available");
    expect(html).toContain('href="/dispatch/"');
    expect(html).not.toContain("Secret");
    expect(html).not.toContain("/secret");
    expect(mounts).toHaveLength(2);
  });

  test("empty and hidden-only registries render the same useful empty state", () => {
    const html = renderIndex([], "305 RP");
    expect(html).toContain("No destinations are listed on this hub.");
    expect(renderIndex([app({ listed: false })], "305 RP")).toBe(html);
  });

  test("escapes resource text, server name and href attributes", () => {
    const attack = `<script>alert('x' & "y")</script>`;
    const html = renderIndex([app({ title: attack, description: attack, mount: "/safe" })], attack);
    expect(html).not.toContain("<script>");
    expect(html).toContain(`<title>${escapeHtml(attack)}</title>`);
    expect(html).toContain(`<div class="name">${escapeHtml(attack)}</div>`);
    expect(html).toContain(`<div class="desc">${escapeHtml(attack)}</div>`);
    expect(html).toContain('href="/safe/"');
    expect(renderIndex([app({ mount: '/x" onclick="bad' })], "Hub")).not.toContain('href="/x');
  });

  test("uses canonical entrypoint paths, never upstream URLs; falls back to id and path", () => {
    const html = renderIndex([app({ title: "", index: "/_/" }), app({ mount: "/db" })], "305 RP");
    expect(html).toContain("2 destinations available");
    expect(html).toContain('<div class="name">dispatch</div>');
    expect(html).toContain('<div class="path">/dispatch/_/</div>');
    expect(html).toContain('href="/dispatch/_/"');
    expect(html).not.toContain('href="http');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<form");
  });

  test("registry validates accents and icon names before rendering", () => {
    const good = register(app({ accent: "#AbC", icon: "database" }));
    const bad = register(
      app({ mount: "/bad", accent: '#fff" onmouseover="bad', icon: '<svg onload="bad">' })
    );
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(true);
    if (!good.ok || !bad.ok) throw new Error("fixture registration failed");
    expect(renderIndex([good.mount], "Hub")).toContain('style="--accent:#abc"');
    const html = renderIndex([bad.mount], "Hub");
    expect(html).not.toContain('style="--accent:');
    expect(html).not.toContain("onload");
    expect(html).not.toContain("onmouseover");
    expect(html).toContain('<svg viewBox="0 0 24 24"');
  });

  test("404/502 details escape untrusted paths and ownership; shared shell retains return link", () => {
    const input = '<img src=x onerror="bad">';
    const missing = notFoundPage(input);
    const unavailable = badGatewayPage(app({ mount: input, resourceName: input }));
    expect(missing).toContain("<title>404 Not found</title>");
    expect(unavailable).toContain("<title>502 Resource unavailable</title>");
    expect(unavailable).toContain("It may still be starting up.");
    for (const html of [missing, unavailable]) {
      expect(html).not.toContain("<img");
      expect(html).toContain(`<code>${escapeHtml(input)}</code>`);
      expect(html).toContain('href="/"');
      expect(html).toContain("--surface:#111");
    }
    expect(renderError(404, input, "Trusted detail")).toContain(`<h1>${escapeHtml(input)}</h1>`);
  });
});

// THE PERMANENT GUARD, AND IT OUTLIVED WHAT IT WAS WRITTEN FOR.
//
// It was written for the diagnostics panel, which carried a `POST /` consent
// switch briefly. The switch went first, then the whole panel (see `hub.ts`).
// The rule the guard encodes is about the PAGE, not the panel: this listener
// binds `0.0.0.0` by default and its index is public and unauthenticated, with
// no auth primitive in `server/lib/http/` to gate a writer with, so NOTHING
// here may be a control. Every page the hub can render, asserted to contain no
// form, button, input, `method="post"` or script.
describe("every hub page is read-only", () => {
  const pages = (): [string, string][] => [
    ["nothing mounted", renderIndex([], "305 RP")],
    ["one destination", renderIndex([app()], "305 RP")],
    ["several destinations", renderIndex([app(), app({ mount: "/db", id: "db" })], "305 RP")],
    ["hidden-only registry", renderIndex([app({ listed: false })], "305 RP")],
    [
      "hostile resource text",
      renderIndex(
        [app({ title: '<form method="post">', description: "<button>go</button>" })],
        "x"
      ),
    ],
    ["404", notFoundPage("/nope")],
    ["502", badGatewayPage(app())],
  ];

  for (const [label, html] of pages()) {
    test(`no control on: ${label}`, () => {
      expect(html).not.toContain("<form");
      expect(html).not.toContain("</form");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("</button");
      expect(html).not.toContain("<input");
      expect(html).not.toContain('method="post"');
      // No script and no external asset either — the page's original property.
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<link");
    });
  }
});

// The diagnostics panel is GONE, and this is the test that stops it coming
// back by accident. The hub is app discovery; the setting's state lives in
// `tlib_telemetry_status`, and the per-install-id disclosure the panel carried
// lives in `docs/content/convars.mdx`.
describe("the hub carries no diagnostics surface", () => {
  test("no page mentions diagnostics, the convar or the install id", () => {
    for (const html of [
      renderIndex([], "305 RP"),
      renderIndex([app()], "305 RP"),
      renderIndex([app(), app({ mount: "/db", id: "db" })], "305 RP"),
      notFoundPage("/nope"),
      badGatewayPage(app()),
    ]) {
      expect(html).not.toContain("Diagnostics");
      expect(html).not.toContain("diagnostics");
      expect(html).not.toContain("tlib_telemetry");
      expect(html).not.toContain("per-install id");
      expect(html).not.toContain("<h2");
      expect(html).not.toContain('class="panel"');
    }
  });

  // The page in full, so the panel's absence is read rather than inferred from
  // a list of `not.toContain`s.
  test("the whole rendered index, printed", () => {
    const html = renderIndex([app(), app({ mount: "/db", id: "db", title: "Database" })], "305 RP");
    console.log(html);
    expect(html).toContain("2 destinations available");
    expect(html.indexOf("</ul>")).toBeLessThan(html.indexOf("<footer>tLib</footer>"));
    // Nothing between the card list and the footer.
    expect(html).toContain("</ul><footer>tLib</footer>");
  });
});
