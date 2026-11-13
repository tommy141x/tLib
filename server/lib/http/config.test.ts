import { describe, expect, test } from "bun:test";
import { bootNotices, resolveConfig } from "./config";

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

// The combination a game host's operator reaches by copying the old-boundary docs: the door
// that needs nothing off, the one that needs a port the host never gave them on. germancatfish
// ran it for four days and was told to open a Windows firewall port on a Linux container.
describe("what the boot log says about the configuration", () => {
  const notices = (set: Record<string, string>) => {
    const cfg = resolveConfig(convars(set));
    return bootNotices(cfg, set.tlib_http_ingress !== "false");
  };

  test("a default install says nothing", () => {
    expect(notices({})).toEqual([]);
  });

  test("a listener beside the ingress says nothing: both doors are wanted", () => {
    expect(notices({ tlib_http_port: "7777" })).toEqual([]);
  });

  test("ingress off with a listener names the port, the host's part, and the lines to delete", () => {
    const [only, ...rest] = notices({ tlib_http_ingress: "false", tlib_http_port: "7777" });
    expect(rest).toEqual([]);
    expect(only.level).toBe("info");
    expect(only.message).toContain("served only on port 7777");
    expect(only.message).toContain("Your host must have given 7777 to this server");
    expect(only.message).toContain("delete 'tlib_http_ingress false' and 'tlib_http_port'");
  });

  test("ingress off with no listener is the error it always was, and not the info line", () => {
    const [only, ...rest] = notices({ tlib_http_ingress: "false" });
    expect(rest).toEqual([]);
    expect(only.level).toBe("error");
    expect(only.message).toContain("no door");
  });

  test("a bind host with no port still warns about the implied port", () => {
    const [only] = notices({ tlib_http_host: "127.0.0.1" });
    expect(only.level).toBe("warn");
    expect(only.message).toContain("7777");
  });
});
