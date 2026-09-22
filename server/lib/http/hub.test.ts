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
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
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
