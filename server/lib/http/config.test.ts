import { describe, expect, test } from "bun:test";
import { resolveConfig } from "./config";

/** A convar table, as GetConvar sees it: absent is the empty string. */
function convars(set: Record<string, string>) {
  return (name: string, fallback: string) => set[name] ?? fallback;
}

describe("binding a port is opt-in", () => {
  test("nothing set binds nothing, and the FiveM server port is the only door", () => {
    expect(resolveConfig(convars({}))).toMatchObject({ port: null, host: "0.0.0.0" });
  });

  test("a port binds it, which is every setup that worked before", () => {
    expect(resolveConfig(convars({ tlib_http_port: "7777" })).port).toBe(7777);
    expect(resolveConfig(convars({ tlib_http_port: "8080" })).port).toBe(8080);
  });

  test("a bind address alone binds, on the port such a server already had open", () => {
    // Setting only the host says where the listener goes, not whether to have
    // one — and 7777 is the number already in that operator's firewall.
    expect(resolveConfig(convars({ tlib_http_host: "127.0.0.1" }))).toMatchObject({
      host: "127.0.0.1",
      port: 7777,
    });
  });

  test("an unusable port still binds, rather than silently removing the listener", () => {
    for (const raw of ["abc", "0", "99999", "-1"]) {
      expect(resolveConfig(convars({ tlib_http_port: raw })).port).toBe(7777);
    }
  });

  test("a convar read that throws is an unset convar, not a bind", () => {
    // GetConvar is absent until the FiveM runtime is up, and resolveConfig is
    // reachable from realtime's exports before then.
    const throwing = () => {
      throw new Error("GetConvar is not a function");
    };
    expect(resolveConfig(throwing)).toMatchObject({ port: null, publicUrlOverride: null });
  });
});
