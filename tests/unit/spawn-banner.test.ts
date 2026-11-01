/**
 * The Spawns row in tLib's startup banner.
 *
 * It exists because the row described other people's servers. The allowlist in
 * `server/lib/spawn/catalog.ts` is hardcoded and ships complete, so until
 * 2026-11-01 every server was told "tDB → pocketbase | tAI → llama-server,
 * tts-sidecar" whether or not either resource was installed. Reported from a
 * boot log on a server that had neither.
 *
 * The row is a STATUS line. The two properties below are what that means, and
 * both were false when the bug was live:
 *
 *   1. It names only what this server actually has.
 *   2. It says nothing when this server has none of it, so versioncheck drops
 *      the row rather than printing an empty one.
 */

import { describe, expect, test } from "bun:test";
import { describeFamily } from "../../server/lib/spawn/catalog";

const none = () => false;
const all = () => true;

describe("describeFamily", () => {
  test("names only installed resources", () => {
    const rows = describeFamily((resource) => resource === "tDB");
    expect(rows.some((r) => r.startsWith("tDB"))).toBe(true);
    expect(rows.some((r) => r.startsWith("tAI"))).toBe(false);
  });

  test("is empty when nothing that spawns is installed, so the row is dropped", () => {
    // versioncheck renders a row only `if entry.value and entry.value ~= ''`,
    // so an empty list is how the Spawns line disappears. Asserted on the
    // joined string because that is what `installSpawn` emits.
    expect(describeFamily(none)).toEqual([]);
    expect(describeFamily(none).join(" | ")).toBe("");
  });

  test("still omits dormant callers even when they are installed", () => {
    // tRadio is dormant: present in the allowlist as disclosure, but it no
    // longer ships the program, so naming it would be a status line about
    // software that cannot run.
    expect(describeFamily(all).some((r) => r.startsWith("tRadio"))).toBe(false);
  });

  test("carries no convar instruction — that is documentation, not status", () => {
    // The row used to append "(one add_unsafe_child_process_permission tLib
    // covers all)" to whatever it listed. It belongs in docs/content/exports.mdx.
    for (const row of describeFamily(all)) {
      expect(row).not.toInclude("add_unsafe_child_process_permission");
      expect(row).not.toInclude("convar");
    }
  });
});
