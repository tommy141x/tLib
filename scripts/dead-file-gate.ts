#!/usr/bin/env bun
// Orphan-file gate: a .ts/.tsx file that nothing imports and no entry point
// names. The negative control is scripts/dead-file-control.ts.
//
// tLib is a PUBLISHED MIT library, consumed by eleven resources here and by
// third parties outside this repo, so "no importer" is the normal state of a
// library file and can never be the verdict on its own. A knip/ts-prune-shaped
// answer flags the entire public API.
//
// Four things keep a file alive, in this order of authority:
//
//   1. shared/ts/package.json's `exports` map — the DECLARED public surface.
//      ui/card, ui/color-picker, ui/meta, ui/progress and ui/tabs are each
//      named there and imported by nothing in this estate; a graph-only gate
//      called all five dead.
//   2. scripts/public-entries.json — the measured record of deep paths
//      consumers import by relative path outside that map. 115 of them:
//      build/*, fs/server, secrets/release, audio/wav, telemetry/*, every ui/*.
//   3. The import graph, through relative specifiers, `@tlib/shared/*`, `@/*`.
//   4. Paths written as STRINGS rather than imported — the ui_page html's
//      module src, and anything a package.json script hands to `bun`. That last
//      is the only thing keeping shared/ts/build/cef-output-contract-control.ts
//      alive, because tRadio is what runs it.
//
// shared/ts/solid-compat/ is excluded: its files are reached by a `virtual:`
// specifier that exists only inside Vite, the same reason shared/ts/tsconfig.json
// excludes it.
//
// Exit 1 = an orphan. Exit 2 = fewer than 250 files or fewer than 50 entry
// points, i.e. a set collapsed, which is NOT a pass.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

const slash = (p: string) => p.split("\\").join("/");

// Trees this gate does not own. client/ui and server/dist are build output,
// export-staging is live Discovery staging, internal/ is a separate repo.
const EXCLUDED = [
	"node_modules/",
	"client/ui/",
	"export-staging/",
	"internal/",
	"server/dist/",
	"shared/ts/dist/",
	".build/",
	".tmp/",
	// The vendor-import shim. Its files are pulled in by a `virtual:` specifier
	// that only exists inside Vite, so an import graph cannot see them at all —
	// shared/ts/tsconfig.json excludes it for the same reason.
	"shared/ts/solid-compat/",
];

// Entry points reached by something other than an import: a package script, a
// test runner, the ui_page html. Matched against repo-relative paths.
const LOCAL_ENTRY_GLOBS = [
	/^scripts\/[^/]+\.(ts|tsx)$/,
	/^client\/web\/(vite|uno)\.config\.ts$/,
	/^client\/web\/vite\/[^/]+\.ts$/,
	/^client\/web\/scripts\/[^/]+\.ts$/,
	/^server\/main\.ts$/,
	/^tests\/browser\/[^/]+\.ts$/,
	/\.d\.ts$/,
	/\.test\.(ts|tsx)$/,
	/^shared\/ts\/rage\/scripts\//,
	/^shared\/ts\/rage-viewer\/scripts\//,
];

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const SPEC = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\(\s*)["']([^"']+)["']/g;

type Skips = Set<string>;

class Gate {
	constructor(
		readonly root: string,
		readonly skips: Skips,
	) {}

	/** The one definition of "a file this gate judges". */
	files(): string[] {
		const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
			cwd: this.root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		return out
			.split("\n")
			.map((l) => slash(l.trim()))
			.filter(Boolean)
			.filter((p) => /\.(ts|tsx)$/.test(p))
			.filter((p) => !EXCLUDED.some((e) => p.startsWith(e) || p.includes(`/${e}`)))
			.filter((p) => existsSync(join(this.root, p)));
	}

	resolveSpec(fromFile: string, spec: string): string | null {
		let base: string | null = null;
		if (spec.startsWith(".")) {
			base = slash(join(dirname(fromFile), spec));
		} else if (spec === "@tlib/shared") {
			base = "shared/ts/index.ts";
		} else if (spec.startsWith("@tlib/shared/")) {
			base = `shared/ts/${spec.slice("@tlib/shared/".length)}`;
		} else if (spec.startsWith("@/") && fromFile.startsWith("client/web/")) {
			base = `client/web/src/${spec.slice(2)}`;
		} else {
			return null;
		}
		base = slash(posix.normalize(base));
		const stripped = base.replace(/\.(js|jsx|mjs)$/, "");
		for (const cand of [base, stripped]) {
			for (const sfx of CANDIDATE_SUFFIXES) {
				const p = cand + sfx;
				if (!/\.(ts|tsx)$/.test(p)) continue;
				const abs = join(this.root, p);
				if (!existsSync(abs)) continue;
				try {
					if (statSync(abs).isFile()) return slash(posix.normalize(p));
				} catch {}
			}
		}
		return null;
	}

	// shared/ts/package.json's `exports` map: the DECLARED public API, which
	// outranks anything inferred from imports. ui/card, ui/color-picker,
	// ui/meta, ui/progress and ui/tabs are each named there and imported by
	// nothing anywhere in this estate — a gate reading only the import graph
	// called all five dead, which is the measured reason this reader exists.
	exportMapEntries(): string[] {
		if (this.skips.has("export-map")) return [];
		const p = join(this.root, "shared/ts/package.json");
		if (!existsSync(p)) return [];
		const map = (JSON.parse(readFileSync(p, "utf8")) as { exports?: Record<string, string> }).exports ?? {};
		const out: string[] = [];
		for (const target of Object.values(map)) {
			if (!/\.(ts|tsx)$/.test(target)) continue;
			out.push(slash(posix.normalize(`shared/ts/${target.replace(/^\.\//, "")}`)));
		}
		return out;
	}

	// The deep paths consumers import directly. tLib is a published MIT library,
	// so a file with no caller inside tLib is the normal case and the import
	// keeping it alive lives in another resource or in a third party's tree.
	// "No importer" can therefore never be the verdict on its own, and the
	// public surface has to be a recorded fact rather than an inference.
	//
	// scripts/public-entries.json is that record, measured from the sibling
	// resources by `--write-baseline` and checked in because a fresh clone has
	// no siblings. It is deliberately NOT a ratchet: an entry no consumer here
	// imports any more may still be imported outside this estate, so
	// `--list-consumer-entries` reports the difference and nothing fails on it.
	// Deleting an entry is a judgement about a published API, and no regex
	// gets to make that one.
	baselineEntries(): string[] {
		if (this.skips.has("baseline")) return [];
		const p = join(this.root, "scripts/public-entries.json");
		if (!existsSync(p)) return [];
		return (JSON.parse(readFileSync(p, "utf8")) as { entries?: string[] }).entries ?? [];
	}

	// Reached by a path written as a string: the ui_page html's module src, and
	// anything a package.json script or another script hands to `bun`. Derived
	// by searching those texts for each file's own path, so a renamed script
	// cannot leave a stale hand-written entry behind.
	stringNamedEntries(files: string[]): string[] {
		if (this.skips.has("string-entries")) return [];
		const out = new Set<string>();
		const html = join(this.root, "client/web/index.html");
		if (existsSync(html)) {
			for (const m of readFileSync(html, "utf8").matchAll(/src="([^"]+\.tsx?)"/g)) {
				const r = this.resolveSpec("client/web/index.html", m[1] as string);
				if (r) out.add(r);
			}
		}
		const prose = [join(this.root, "package.json"), join(this.root, "client/web/package.json")]
			.filter((p) => existsSync(p))
			.map((p) => readFileSync(p, "utf8"))
			.concat(
				files
					.filter((f) => f.startsWith("scripts/") && !f.endsWith("dead-file-gate.ts"))
					.map((f) => readFileSync(join(this.root, f), "utf8")),
			)
			.join("\n");
		for (const f of files) if (prose.includes(f)) out.add(f);
		return [...out];
	}

	run(minFiles: number, minEntries: number): { code: number; lines: string[] } {
		const lines: string[] = [];
		const files = this.files();
		if (files.length < minFiles) {
			lines.push(`dead-file-gate: only ${files.length} files measured; the file set collapsed.`);
			return { code: 2, lines };
		}
		const universe = new Set(files);
		const edges = new Map<string, string[]>();
		for (const f of files) {
			const src = readFileSync(join(this.root, f), "utf8");
			const targets: string[] = [];
			if (!this.skips.has("graph")) {
				for (const m of src.matchAll(SPEC)) {
					const r = m[1] ? this.resolveSpec(f, m[1]) : null;
					if (r && universe.has(r)) targets.push(r);
				}
			}
			edges.set(f, targets);
		}

		const roots = new Set<string>();
		for (const p of this.exportMapEntries()) if (universe.has(p)) roots.add(p);
		for (const p of this.baselineEntries()) if (universe.has(p)) roots.add(p);
		if (!this.skips.has("local-entries"))
			for (const f of files) if (LOCAL_ENTRY_GLOBS.some((re) => re.test(f))) roots.add(f);
		for (const f of this.stringNamedEntries(files)) roots.add(f);

		if (roots.size < minEntries) {
			lines.push(`dead-file-gate: only ${roots.size} entry points; the root set collapsed.`);
			return { code: 2, lines };
		}

		const seen = new Set<string>();
		const stack = [...roots];
		while (stack.length) {
			const cur = stack.pop() as string;
			if (seen.has(cur)) continue;
			seen.add(cur);
			for (const t of edges.get(cur) ?? []) if (!seen.has(t)) stack.push(t);
		}

		const orphans = files.filter((f) => !seen.has(f)).sort();
		lines.push(`dead-file-gate: ${files.length} files, ${roots.size} entry points, ${seen.size} reachable`);
		if (!orphans.length) {
			lines.push("dead-file-gate: no orphan files");
			return { code: 0, lines };
		}
		lines.push(`dead-file-gate: ${orphans.length} orphan file(s) — imported by nothing, named by no entry point:`);
		for (const o of orphans) lines.push(`  ${o}`);
		return { code: 1, lines };
	}

	// Re-derive the deep public entry set from every sibling resource on disk.
	// Advisory: a fresh clone has no siblings and this answers nothing.
	consumerEntries(): string[] {
		const found = new Set<string>();
		// spawnSync, and stdout is read whatever the status: rg exits 2 on any
		// unreadable path and one sibling contains a `nul`, so a nonzero status
		// here does not mean there were no matches.
		const r = spawnSync(
			"rg",
			["-NIoe", "(tLib/shared/ts/|@tlib/shared/)[A-Za-z0-9_./-]+", "--glob", "!tLib/**", "."],
			{ cwd: resolve(this.root, ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		for (const line of (r.stdout ?? "").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			const sub = t.includes("tLib/shared/ts/")
				? t.slice(t.indexOf("tLib/shared/ts/") + "tLib/shared/ts/".length)
				: t.slice(t.indexOf("@tlib/shared/") + "@tlib/shared/".length);
			const hit = this.resolveSpec("shared/ts/x.ts", `./${sub}`);
			if (hit) found.add(hit);
		}
		return [...found].sort();
	}
}

export { Gate };

function cli(argv: string[]): number {
	const root = argv.find((a) => a.startsWith("--root="))?.slice(7);
	// Control-only. The floors exist to catch a collapsed file set in the real
	// repo, where both numbers are far above anything a fixture can reach — so
	// the control lowers them, and also asserts that WITHOUT the flag a fixture
	// trips them. The flag is therefore itself covered rather than a hole.
	const floors = argv.find((a) => a.startsWith("--floors="))?.slice(9);
	const [minFiles, minEntries] = floors ? floors.split(",").map(Number) : [250, 50];
	const skips: Skips = new Set(argv.filter((a) => a.startsWith("--skip=")).map((a) => a.slice(7)));
	const gate = new Gate(root ? resolve(root) : resolve(import.meta.dir, ".."), skips);

	if (argv.includes("--write-baseline")) {
		const found = gate.consumerEntries();
		if (!found.length) {
			console.error("dead-file-gate: --write-baseline needs the sibling resources on disk.");
			return 2;
		}
		const body = {
			"//":
				"Deep paths into shared/ts that consumers import directly, measured by " +
				"`bun run scripts/dead-file-gate.ts --write-baseline`. Checked in because a fresh " +
				"clone has no siblings. Not a ratchet — see the note in scripts/dead-file-gate.ts.",
			entries: found,
		};
		writeFileSync(join(gate.root, "scripts/public-entries.json"), `${JSON.stringify(body, null, "\t")}\n`);
		console.log(`dead-file-gate: wrote ${found.length} public entries to scripts/public-entries.json`);
		return 0;
	}

	if (argv.includes("--list-consumer-entries")) {
		const found = gate.consumerEntries();
		const recorded = gate.baselineEntries();
		console.log(`consumer deep entries on disk: ${found.length}`);
		if (!found.length) console.log("  (no sibling resources on disk)");
		for (const f of found) console.log(`  ${recorded.includes(f) ? "recorded" : "MISSING "} ${f}`);
		const gone = recorded.filter((r) => found.length > 0 && !found.includes(r));
		for (const g of gone) console.log(`  stale?   ${g}  — recorded, no consumer here imports it now`);
	}

	const { code, lines } = gate.run(minFiles as number, minEntries as number);
	for (const l of lines) (code === 0 ? console.log : console.error)(l);
	return code;
}

if (import.meta.main) process.exit(cli(process.argv.slice(2)));
