import { describe, expect, test } from "bun:test";
import { composeWsUrl } from "./config";

/**
 * Realtime is the one thing the FiveM server port cannot carry: WebSocket has no
 * upgrade surface there. So with no listener there is no address, and saying so
 * is the whole contract — a URL naming a port nothing listens on would be a
 * client retrying forever against a closed socket.
 */
describe("the realtime URL exists only when a socket does", () => {
  test("a listener's port composes the mount onto the detected address", () => {
    expect(composeWsUrl(null, "203.0.113.10", 7777)).toBe("ws://203.0.113.10:7777/rt");
  });

  test("no listener means no URL, not localhost and not the FiveM port", () => {
    expect(composeWsUrl(null, "203.0.113.10", null)).toBeNull();
    expect(composeWsUrl(null, null, null)).toBeNull();
  });

  test("an override is an address the operator arranged, so it survives no listener", () => {
    expect(composeWsUrl("wss://rt.example.com/rt", null, null)).toBe("wss://rt.example.com/rt");
  });
});
