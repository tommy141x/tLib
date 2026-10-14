#!/usr/bin/env bun
// Negative control for scripts/dead-file-gate.ts, over REAL git repositories
// created in the OS temp dir — a real `git init`, because the gate gets its file
// set from `git ls-files` and a fixture that is not a repo exercises a different
// path from the one that runs in anger.
//
// It plants one orphan and requires it to be REPORTED BY NAME, then requires
// that same orphan to go GREEN through each of the gate's four readers in turn:
// the exports map, the recorded baseline, an import from a reachable file, and a
// package.json script string. Those four are the four ways a library file
// legitimately has no importer, and getting any one of them wrong is how an audit
// comes to recommend deleting a published API.
//
// A fixture of CORRECT shapes must stay green: a `.d.ts` and a `.test.ts` have no
// importer by their nature, and a gate that reports either is a gate that gets
// switched off. Both vacuity floors are asserted in the direction that matters —
// a collapsed file set and a collapsed root set each exit 2, not 0.
//
// Then FIVE broken-gate drills, one per reader: each reader is removed in turn and
// the fixture that was green BECAUSE of it must go red. Without those, "the
// exports map kept it alive" is a claim about an exit code and nothing more.
//
// A passing run proves the readers still FIRE. It does not prove the entry-point
// set is complete, and it cannot judge whether a file with no importer anywhere is
// dead or an unused public API — that belongs to whoever owns the published
// surface.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const GATE = resolve(import.meta.dir, "dead-file-gate.ts");
const REPO = resolve(import.meta.dir, "..");

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
	checks++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
	if (!ok) failures++;
}

// The fixture. Deliberately a REAL git repository in the OS temp dir: the gate
// gets its file set from `git ls-files`, so a fixture that is not a repo would
// exercise a different code path from the one that runs in anger. Nothing is
// written into the tree — other agents work in this tree.
// `check:imports` scans this file's TEXT and cannot tell a fixture body from
// real code, so every fixture specifier is assembled rather than written out.
// A literal `from "./core.ts"` in here is reported as an unresolved import, and
// the alternatives were a fixture with no imports at all — which cannot
// exercise the import graph, the thing half these cases are about — or a gate
// left red.
const from = (spec: string) => `from "${spec}"`;

const BASE: Record<string, string> = {
	"package.json": JSON.stringify({ scripts: { probe: "bun scripts/probe.ts" } }, null, 2),
	"scripts/public-entries.json": JSON.stringify({ entries: [] }, null, 2),
	"shared/ts/package.json": JSON.stringify(
		{ exports: { ".": "./index.ts", "./pub": "./pub.ts" } },
		null,
		2,
	),
	"shared/ts/index.ts": `export { core } ${from("./core.ts")};\n`,
	"shared/ts/core.ts": "export const core = 1;\n",
	"shared/ts/pub.ts": "export const pub = 2;\n",
	"scripts/probe.ts": "console.log(1);\n",
	"server/main.ts": `import { core } ${from("../shared/ts/index.ts")};\nconsole.log(core);\n`,
	"client/web/index.html": '<script type="module" src="./src/index.tsx"></script>\n',
	"client/web/src/index.tsx": `import { App } ${from("./app.tsx")};\nexport default App;\n`,
	"client/web/src/app.tsx": "export const App = () => null;\n",
};

/** The fixture's one import of the planted orphan, used by two cases. */
const IMPORTS_ORPHAN = { "shared/ts/core.ts": `export { orphan } ${from("./orphan.ts")};\n` };

// Five entry points (index.ts and pub.ts from the exports map, probe.ts and
// main.ts from the local globs, index.tsx from the html) over seven .ts/.tsx
// files, so the floors are set just under that.
const FLOORS = "--floors=7,5";

function fixture(extra: Record<string, string> = {}, drop: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "tlib-deadfile-"));
	const tree = { ...BASE, ...extra };
	for (const d of drop) delete tree[d];
	for (const [p, body] of Object.entries(tree)) {
		mkdirSync(dirname(join(dir, p)), { recursive: true });
		writeFileSync(join(dir, p), body);
	}
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

function gate(dir: string, ...args: string[]): { code: number; out: string } {
	const r = Bun.spawnSync(["bun", GATE, `--root=${dir}`, ...args], { stdout: "pipe", stderr: "pipe" });
	return {
		code: r.exitCode,
		out: `${r.stdout.toString()}${r.stderr.toString()}`,
	};
}

function withFixture(extra: Record<string, string>, args: string[], fn: (r: { code: number; out: string }) => void) {
	const dir = fixture(extra);
	try {
		fn(gate(dir, ...args));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// 1. The real repo is green. Without this no red result below is attributable
//    to a planted orphan rather than to the gate being broken.
{
	const r = Bun.spawnSync(["bun", GATE, `--root=${REPO}`], { stdout: "pipe", stderr: "pipe" });
	check(
		"baseline: the real repo has no orphan files",
		r.exitCode === 0,
		`exit ${r.exitCode}\n     ${r.stdout.toString()}${r.stderr.toString()}`,
	);
}

// 2. A clean fixture is green, so the fixture itself is not the finding.
withFixture({}, [FLOORS], (r) => {
	check("fixture: clean tree is green", r.code === 0 && r.out.includes("no orphan files"), `exit ${r.code}\n     ${r.out}`);
});

const ORPHAN = { "shared/ts/orphan.ts": "export const orphan = 3;\n" };

// 3. The thing the gate is for.
withFixture(ORPHAN, [FLOORS], (r) => {
	check(
		"a planted orphan turns the gate red and is named",
		r.code === 1 && r.out.includes("shared/ts/orphan.ts") && r.out.includes("1 orphan file"),
		`exit ${r.code}\n     ${r.out}`,
	);
});

// 4-7. Each reader that can keep a file alive, one at a time. These are the
//      four ways a library file legitimately has no importer, and getting any
//      one of them wrong is how an audit recommends deleting a public API.
withFixture(
	{
		...ORPHAN,
		"shared/ts/package.json": JSON.stringify(
			{ exports: { ".": "./index.ts", "./pub": "./pub.ts", "./orphan": "./orphan.ts" } },
			null,
			2,
		),
	},
	[FLOORS],
	(r) => check("named in shared/ts/package.json exports: green", r.code === 0, `exit ${r.code}\n     ${r.out}`),
);

withFixture(
	{ ...ORPHAN, "scripts/public-entries.json": JSON.stringify({ entries: ["shared/ts/orphan.ts"] }, null, 2) },
	[FLOORS],
	(r) => check("recorded in scripts/public-entries.json: green", r.code === 0, `exit ${r.code}\n     ${r.out}`),
);

withFixture({ ...ORPHAN, ...IMPORTS_ORPHAN }, [FLOORS], (r) =>
	check("imported by a reachable file: green", r.code === 0, `exit ${r.code}\n     ${r.out}`),
);

withFixture(
	{ ...ORPHAN, "package.json": JSON.stringify({ scripts: { probe: "bun shared/ts/orphan.ts" } }, null, 2) },
	[FLOORS],
	(r) => check("named by a package.json script string: green", r.code === 0, `exit ${r.code}\n     ${r.out}`),
);

// 8. The html's module src, which is the only thing that reaches the NUI entry.
withFixture({ "client/web/index.html": "<p>no script tag</p>\n" }, ["--floors=7,4"], (r) =>
	check(
		"with no html script src, the NUI entry IS reported",
		r.code === 1 && r.out.includes("client/web/src/index.tsx"),
		`exit ${r.code}\n     ${r.out}`,
	),
);

// 9. A .d.ts and a .test.ts have no importer by their nature and must not be
//    findings. A gate that reports either gets switched off.
withFixture(
	{ "shared/ts/env.d.ts": "declare const x: number;\n", "shared/ts/core.test.ts": "export const t = 1;\n" },
	[FLOORS],
	(r) => check("a .d.ts and a .test.ts are not findings", r.code === 0, `exit ${r.code}\n     ${r.out}`),
);

// 10-11. Both vacuity floors, in the direction that matters: a collapsed set
//        must exit 2, which is NOT a pass.
withFixture(ORPHAN, [], (r) =>
	check(
		"without --floors the fixture trips the file floor with exit 2",
		r.code === 2 && r.out.includes("file set collapsed"),
		`exit ${r.code}\n     ${r.out}`,
	),
);

withFixture(ORPHAN, ["--floors=7,999"], (r) =>
	check(
		"an unreachable entry-point floor exits 2, not 1",
		r.code === 2 && r.out.includes("root set collapsed"),
		`exit ${r.code}\n     ${r.out}`,
	),
);

// BROKEN-GATE DRILLS. Each removes one reader and requires the fixture that
// was green BECAUSE of that reader to go red. Without these, "the exports map
// kept it alive" is an assertion about a green exit code and nothing more —
// a reader deleted outright would leave every case above passing.
withFixture(
	{
		...ORPHAN,
		"shared/ts/package.json": JSON.stringify(
			{ exports: { ".": "./index.ts", "./pub": "./pub.ts", "./orphan": "./orphan.ts" } },
			null,
			2,
		),
	},
	["--floors=7,3", "--skip=export-map"],
	(r) =>
		check(
			"drill: with the exports-map reader removed, the export-map case reddens",
			r.code === 1 && r.out.includes("shared/ts/orphan.ts"),
			`exit ${r.code}\n     ${r.out}`,
		),
);

withFixture(
	{ ...ORPHAN, "scripts/public-entries.json": JSON.stringify({ entries: ["shared/ts/orphan.ts"] }, null, 2) },
	[FLOORS, "--skip=baseline"],
	(r) =>
		check(
			"drill: with the baseline reader removed, the recorded case reddens",
			r.code === 1 && r.out.includes("shared/ts/orphan.ts"),
			`exit ${r.code}\n     ${r.out}`,
		),
);

withFixture(
	{ ...ORPHAN, ...IMPORTS_ORPHAN },
	[FLOORS, "--skip=graph"],
	(r) =>
		check(
			"drill: with the import graph removed, the imported case reddens",
			r.code === 1 && r.out.includes("shared/ts/orphan.ts"),
			`exit ${r.code}\n     ${r.out}`,
		),
);

withFixture(
	{ ...ORPHAN, "package.json": JSON.stringify({ scripts: { probe: "bun shared/ts/orphan.ts" } }, null, 2) },
	["--floors=7,4", "--skip=string-entries"],
	(r) =>
		check(
			"drill: with the string-path reader removed, the script-named case reddens",
			r.code === 1 && r.out.includes("shared/ts/orphan.ts"),
			`exit ${r.code}\n     ${r.out}`,
		),
);

withFixture(
	{ "shared/ts/env.d.ts": "declare const x: number;\n", "shared/ts/core.test.ts": "export const t = 1;\n" },
	["--floors=9,3", "--skip=local-entries"],
	(r) =>
		check(
			"drill: with the local-entry globs removed, the .d.ts and .test.ts reddens",
			r.code === 1 && r.out.includes("env.d.ts") && r.out.includes("core.test.ts"),
			`exit ${r.code}\n     ${r.out}`,
		),
);

console.log(`\ndead-file control: ${checks - failures}/${checks} checks passed`);
if (failures) {
	console.error(`CONTROL FAILED: ${failures} of ${checks}`);
	process.exit(1);
}
process.exit(0);
