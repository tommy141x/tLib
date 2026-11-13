/**
 * What a player sees when the marketplace list does not load.
 *
 * Drives the real MarketplaceBrowser through the same wire the game uses: a POST to
 * the `marketplaceBrowse` callback, then a `marketplaceBrowseResult` message back
 * from Lua. A 404 from a host that is mid-deploy used to render as `Failed to load
 * marketplace` over a raw status line; an empty catalogue as `No items found.`.
 * Those are different situations with different advice, and these cases pin that
 * they read differently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { MarketplaceBrowser } from "../src/components/marketplace/MarketplaceBrowser";

const realFetch = globalThis.fetch;
let browseRequests: { requestId: string; type?: string; resource?: string; search?: string }[] = [];

beforeEach(() => {
  browseRequests = [];
  (window as unknown as { GetParentResourceName: () => string }).GetParentResourceName = () =>
    "tLib";
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/marketplaceBrowse")) {
      browseRequests.push(JSON.parse(String(init?.body)));
    }
    return new Response("1");
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  delete (window as unknown as { GetParentResourceName?: unknown }).GetParentResourceName;
});

function reply(data: Record<string, unknown>) {
  const last = browseRequests[browseRequests.length - 1];
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { action: "marketplaceBrowseResult", data: { requestId: last?.requestId, ...data } },
    })
  );
}

async function mount(initialTab: "uis" | "sounds") {
  const view = render(() => (
    <MarketplaceBrowser
      active
      data={{ baseUrl: "https://example.test", resource: "tDetector", initialTab }}
    />
  ));
  flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  expect(browseRequests.length).toBeGreaterThan(0);
  return view;
}

async function settled() {
  // The spinner is held for 300 ms so it never flashes.
  await new Promise((resolve) => setTimeout(resolve, 350));
  flush();
}

describe("a failed list", () => {
  test("a 404 says it is not an empty catalogue and that installs are safe", async () => {
    const view = await mount("sounds");
    expect(browseRequests[0].type).toBe("sound");
    reply({ ok: false, error: "http_404 (HTTP 404)", kind: "not_found" });
    await settled();
    const alert = view.getByRole("alert");
    expect(alert.textContent).toContain("The marketplace could not find its catalogue");
    expect(alert.textContent).toContain("not found");
    expect(alert.textContent).toContain("Nothing you have installed is affected");
    expect(alert.textContent).toContain("http_404 (HTTP 404)");
    expect(alert.textContent).not.toContain("Failed to load marketplace");
  });

  test("an unreachable host reads differently from a 404", async () => {
    const view = await mount("sounds");
    reply({
      ok: false,
      error: "could not reach the marketplace host (ENOTFOUND)",
      kind: "unreachable",
    });
    await settled();
    const alert = view.getByRole("alert");
    expect(alert.textContent).toContain("This server cannot reach the marketplace");
    expect(alert.textContent).toContain("ENOTFOUND");
    expect(alert.textContent).not.toContain("could not find its catalogue");
  });

  test("a failure with no kind, as an older tLib sends it, still renders with its message", async () => {
    const view = await mount("uis");
    reply({ ok: false, error: "something odd" });
    await settled();
    const alert = view.getByRole("alert");
    expect(alert.textContent).toContain("Failed to load marketplace");
    expect(alert.textContent).toContain("something odd");
  });

  test("Retry asks again", async () => {
    const view = await mount("sounds");
    reply({ ok: false, error: "http_503 (HTTP 503)", kind: "unavailable" });
    await settled();
    const before = browseRequests.length;
    view.getByText("Retry").click();
    flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(browseRequests.length).toBe(before + 1);
  });
});

describe("an empty list", () => {
  test("is not a failure and names what is missing", async () => {
    const view = await mount("sounds");
    reply({ ok: true, items: [], total: 0, nextCursor: 0, hasMore: false });
    await settled();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByText("No sounds are published for tDetector yet.")).toBeTruthy();
  });

  test("on the UIs tab says UIs", async () => {
    const view = await mount("uis");
    reply({ ok: true, items: [], total: 0, nextCursor: 0, hasMore: false });
    await settled();
    expect(view.getByText("No UIs are published for tDetector yet.")).toBeTruthy();
  });
});

describe("the first open of a session", () => {
  // `applyOpenData` writes `baseUrl` and `resourceFilter` and fetches in the same tick,
  // where a Solid 2 read still returns the old value. The fetch used to see an empty
  // base URL and return without asking, so a first open showed the empty state until
  // a tab was clicked. The fix reads the payload itself; the risk it carries is a
  // browse that is not scoped to the product, which is what the resource assertion pins.
  test("asks the host at once, scoped to the product and the opening tab", async () => {
    await mount("sounds");
    expect(browseRequests).toHaveLength(1);
    expect(browseRequests[0]).toMatchObject({ type: "sound", resource: "tDetector" });
    expect(browseRequests[0].search).toBeUndefined();
  });
});
