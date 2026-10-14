# Comment style

Enforced by `bun run check:comments` (`scripts/comment-style-gate.ts`). The gate
is in `check:regression`, so it runs in `verify`.

## Remove

- **Emoji.** No `⚠️ 🔴 ⛔ ⭐ ✅ 🟡 🟢` in a comment. Say the thing in words, or
  put it in a doc.
- **Box-drawing dividers.** No `── Section ──`, `═══`, `─────`. A blank line
  separates sections; a heading does not need a rule under it.
- **Narrative and session residue.** No "Measured 2026-10-12", "I checked",
  "found by", "two agents got this wrong", "as of today". Git records when and
  who, and a dated claim rots.
- **Comments restating the code.** `-- loop over the players` above a player
  loop is noise.
- **Tombstones for removed code.** Git history is the record. One exception: a
  single line where the removal would otherwise be re-done by someone who does
  not know why. One line, not a paragraph.
- **Multi-paragraph file headers.** At most two lines saying what the file is.

## Keep, compressed

- A surprising behaviour that would cost someone hours. One or two lines, plain,
  present tense, no drama.
- A constraint not visible from the code: an external API's limit, a platform
  quirk, an ordering requirement.

## Never cite a moving target

A comment naming a line number, a file path, a count or a version is a
liability. In a sibling resource a ledger of "five live bugs" had three already
fixed and every line number stale by hundreds of lines, and an agent was nearly
sent to fix working code from it. Name a symbol, not a location. A comment that
says *why* stays true; one that says *what the code does* goes wrong.

## Move knowledge, do not delete it

Long comments often carry real findings. The volume is the problem, not the
information. Where a comment carries engineering rationale a maintainer needs:

| Audience | Home |
| --- | --- |
| Operators and consumers | `docs/content/*.mdx` (published) |
| Maintainers of a module | the module's co-located `README.md` (tracked) |
| Internal process and audits | `docs/internal/` (**gitignored** — not pushed) |

Leave at most a one-line pointer in the code. Compress on the way: a 40-line
header that becomes three sentences should be three sentences, not 40 lines in a
different file.

Where a comment carries nothing the code does not already say, delete it.

## The ratio

A file of 200+ lines may not be more than 30% whole-line comments. The gate
measures whole-line comments only — a trailing `// why` on a line of code does
not count against it.

30% is not a target. It is the point past which a file is prose with code in it.
When the gate was written tLib averaged 24.8%, and the worst single file was 77%
comment. A file that needs more explanation than that needs a README beside it.

### The ratchet

Files already over the ceiling are pinned in
`scripts/comment-ratio-baseline.json` at the count they had. That is a ratchet,
not an allowlist:

- A pinned file may only shrink. Growing one fails the gate.
- The moment a pinned file is at or under the ceiling, the gate demands its entry
  be **deleted**. The ledger cannot outlive what it describes.
- An entry naming a file the gate no longer measures fails too.

A new file is never pinned. `--write-baseline` regenerates the file; use it only
to record a pin you meant to add.

## Licences stay verbatim

Licence headers, SPDX lines and font licences are not edited. The gate skips any
file with a licence or copyright notice in its first 2 KB.
