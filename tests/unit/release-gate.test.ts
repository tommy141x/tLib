import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toSemver } from "../../shared/ts/build/version";
import {
  assertReleasable,
  assertVersionShape,
  bunGit,
  tagRelease,
} from "../../shared/ts/build/release-gate";

// Real git, not a fake: the gate is a statement about what `git` says, and a stub that
// answers what the gate hopes to hear would prove the gate agrees with itself.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(version = "1.1") {
  const root = mkdtempSync(join(tmpdir(), "tlib-gate-"));
  roots.push(root);
  const git = bunGit(root);
  const run = (...args: string[]) => {
    const r = git(["-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
    if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.out}`);
    return r.out;
  };
  run("init", "-q");
  writeFileSync(join(root, "fxmanifest.lua"), `version '${version}'\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: toSemver(version) }));
  writeFileSync(join(root, "a.lua"), "one\n");
  run("add", "-A");
  run("commit", "-q", "-m", "first");
  return { root, git, run };
}

const gate = (r: ReturnType<typeof repo>, version: string, dev = false) =>
  assertReleasable({
    root: r.root,
    version,
    dev,
    versionTargets: [{ kind: "json", file: "package.json" }],
    git: r.git,
  });

describe("version shape", () => {
  test("X.Y and X.Y.Z with Z above zero are the only spellings", () => {
    for (const ok of ["1.1", "0.17", "1.1.1", "1.1.12", "10.0"]) {
      expect(() => assertVersionShape(ok)).not.toThrow();
    }
    // `1.1.0` is `1.1` written twice: a second spelling that would dodge the tag lookup.
    for (const bad of ["1.1.0", "1", "v1.1", "1.1.1.1", "1.1-rc1", "1.1+deadbeef", ""]) {
      expect(() => assertVersionShape(bad)).toThrow("is not X.Y or X.Y.Z");
    }
  });
});

describe("release gate", () => {
  test("a clean tree with no tag passes, names the commit and asks for the tag", async () => {
    const r = repo();
    const state = await gate(r, "1.1");
    expect(state).toMatchObject({ version: "1.1", dev: false, needsTag: true });
    expect(state.commit).toMatch(/^[0-9a-f]{7}$/);
  });

  test("an uncommitted change is refused and named", async () => {
    const r = repo();
    writeFileSync(join(r.root, "a.lua"), "two\n");
    await expect(gate(r, "1.1")).rejects.toThrow(/uncommitted changes[\s\S]*a\.lua/);
  });

  test("an untracked file counts: it would ship in the zip", async () => {
    const r = repo();
    writeFileSync(join(r.root, "new.lua"), "x\n");
    await expect(gate(r, "1.1")).rejects.toThrow("uncommitted changes");
  });

  test("a tag on different files refuses the version, whichever way the tag is spelled", async () => {
    for (const tag of ["v1.1", "v1.1.0"]) {
      const r = repo();
      r.run("tag", tag);
      writeFileSync(join(r.root, "a.lua"), "two\n");
      r.run("add", "-A");
      r.run("commit", "-q", "-m", "fix");
      await expect(gate(r, "1.1")).rejects.toThrow(`already released as tag ${tag}`);
    }
  });

  test("raising the version after the fix passes", async () => {
    const r = repo();
    r.run("tag", "v1.1");
    writeFileSync(join(r.root, "a.lua"), "two\n");
    writeFileSync(join(r.root, "fxmanifest.lua"), "version '1.1.1'\n");
    writeFileSync(join(r.root, "package.json"), JSON.stringify({ version: "1.1.1" }));
    r.run("add", "-A");
    r.run("commit", "-q", "-m", "fix");
    expect(await gate(r, "1.1.1")).toMatchObject({ needsTag: true });
  });

  test("rebuilding the exact tagged tree is allowed and needs no second tag", async () => {
    const r = repo();
    r.run("tag", "v1.1");
    expect(await gate(r, "1.1")).toMatchObject({ needsTag: false });
  });

  test("package.json disagreeing with the manifest is refused", async () => {
    const r = repo();
    writeFileSync(join(r.root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    r.run("add", "-A");
    r.run("commit", "-q", "-m", "stale");
    await expect(gate(r, "1.1")).rejects.toThrow("Version sync missed package.json");
  });

  test("tagRelease records the version, so the NEXT build is refused", async () => {
    const r = repo();
    const state = await gate(r, "1.1");
    expect(tagRelease(r.git, "tLib", state.version, "20261113-deadbeef")).toBe("v1.1");
    expect(r.run("tag", "-n1", "-l", "v1.1")).toContain("tLib 1.1 build 20261113-deadbeef");
    expect((await gate(r, "1.1")).needsTag).toBe(false);
    writeFileSync(join(r.root, "a.lua"), "two\n");
    r.run("add", "-A");
    r.run("commit", "-q", "-m", "fix");
    await expect(gate(r, "1.1")).rejects.toThrow("already released as tag v1.1");
  });

  test("a tag that cannot be made says the zip exists without one", () => {
    const r = repo();
    r.run("tag", "v1.1");
    expect(() => tagRelease(r.git, "tLib", "1.1", "x")).toThrow("could not be created");
  });

  test("--dev skips every refusal and marks a modified tree in the commit", async () => {
    const r = repo();
    r.run("tag", "v1.1");
    writeFileSync(join(r.root, "a.lua"), "two\n");
    const state = await gate(r, "1.1", true);
    expect(state).toMatchObject({ dev: true, needsTag: false });
    expect(state.commit).toMatch(/^[0-9a-f]{7}\+dirty$/);
  });

  test("outside a git checkout a release is refused and a dev build says unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "tlib-nogit-"));
    roots.push(root);
    const input = { root, version: "1.1", git: bunGit(root) };
    await expect(assertReleasable({ ...input, dev: false })).rejects.toThrow("not a git checkout");
    expect((await assertReleasable({ ...input, dev: true })).commit).toBe("unknown");
  });
});
