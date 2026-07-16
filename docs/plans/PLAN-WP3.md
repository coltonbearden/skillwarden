# WP-3 — `diff <id>`: implementation plan

> **For agentic workers:** execute via superpowers:subagent-driven-development — fresh
> subagent per task, TDD inside each task (failing test → minimal code → green → gate →
> commit). Task text + SPEC-WP3 slices are the whole context a subagent gets.

**Goal:** `skillwarden diff <id>` renders upstream content changes for a pinned skill,
with the digest-proven-local before side (D-13) — per `docs/specs/SPEC-WP3.md` (R-17).

**Architecture:** a pure diff engine (`src/core/diff-engine.ts`: Myers line diff,
unified rendering, per-file state computation) fed by a filesystem before-side resolver;
`commands/diff.ts` is a thin orchestrator reusing the existing client/lockfile/error
layers. Targets v0.2.0 — implemented after the v0.1.0 tag.

## Global constraints

- Zero runtime dependencies; stdlib-only diff rendering.
- Suite green with no network/token at every commit; new messages/exit codes are exact
  contracts (SPEC-WP3 error table).
- Both diff sides are CRLF→LF-normalized (`normalizeText`) — line-ending-only
  differences must be impossible (HANDOFF invariant 7).
- `lockfileVersion` stays 1; no lockfile schema change.

Execution order = task number order.

### W3-T1 — Myers line diff + unified rendering (pure) [M] (R-17) — deps: none

**Files:** create `src/core/diff-engine.ts`; create `tests/unit/diff-engine.test.ts`;
modify `src/core/discovery.ts` (export `normalizeText`).

`discovery.ts`: the existing private normalization works on Buffers; add the exact
export (delegating to it, BOM-stripping + CRLF→LF):

```ts
export function normalizeText(contents: string): string;
```

`diff-engine.ts` interfaces:

```ts
export interface LineEdit {
  kind: 'same' | 'del' | 'add';
  line: string;
}
/** Myers O(ND) shortest edit script over line arrays. Deterministic. */
export function diffLines(before: string[], after: string[]): LineEdit[];
/**
 * Unified-format patch: "--- a/<path>", "+++ b/<path>", @@ hunks, 3 context lines
 * (merge hunks whose contexts touch). Returns '' when inputs are equal.
 * null side = absent file (added/removed renders against empty).
 */
export function renderUnified(
  path: string,
  before: string | null,
  after: string | null,
  context?: number,
): string;
```

**TDD ordering (write each failing test, then minimal code):**

1. `diffLines`: equal arrays → all `same`; pure insert; pure delete; replace line;
   common-prefix/suffix trim; empty-vs-content both directions; determinism (same input
   twice → deep-equal output).
2. `renderUnified`: equal → `''`; single change → one `@@ -l,c +l,c @@` hunk with 3
   context lines; changes 10 lines apart → two hunks; changes 5 lines apart → merged
   single hunk; `before: null` → all-`+` body with `--- /dev/null`; `after: null` →
   all-`-` with `+++ /dev/null`; no trailing-newline input handled (last line still
   rendered).

**Verify:** `node --test tests/unit/diff-engine.test.ts` green; full gate.
**Commit:** `feat: pure Myers line diff with unified rendering (R-17)`

### W3-T2 — before-side resolver + per-file state computation [M] (R-17) — deps: W3-T1

**Files:** modify `src/core/diff-engine.ts`; extend `tests/unit/diff-engine.test.ts`.

```ts
export type BeforeReason = 'local copy modified' | 'local file missing' | 'local directory missing';
export type BeforeSide = Map<string, { content: string } | { reason: BeforeReason }>;
/**
 * D-13: for each pinned path, the local file (normalized) is the before side iff
 * digestContent(local) === pinned digest; otherwise a reason. A missing dirAbs maps
 * every path to 'local directory missing'.
 */
export function resolveBeforeSide(dirAbs: string, pinnedFiles: Record<string, string>): BeforeSide;

export interface FileDiffEntry {
  path: string;
  status: 'unchanged' | 'modified' | 'added' | 'removed';
  diffAvailable: boolean;
  reason?: BeforeReason;
  patch?: string; // unified diff text; only when diffAvailable
}
export interface SkillDiffReport {
  upstreamChanged: boolean;
  counts: { unchanged: number; modified: number; added: number; removed: number };
  files: FileDiffEntry[]; // sorted by path
}
/** Pure: SPEC-WP3 per-file state table over union(pinned paths, current paths). */
export function computeDiff(
  pinnedFiles: Record<string, string>,
  currentFiles: { path: string; contents: string }[],
  before: BeforeSide,
): SkillDiffReport;
```

State rules (from the spec table): `unchanged` ⇐ `digestContent(current) === pinned`;
`modified` ⇐ both sides, digests differ — `patch` iff `before` has content;
`added` ⇐ current only — `patch` always (`before: null`); `removed` ⇐ pinned only —
`patch` iff local digest-proven, else name-only entry.

**TDD ordering:**

1. `resolveBeforeSide` (temp dirs, reuse `writeSkill` from `tests/helpers.ts`):
   matching digest → content (normalized); tampered file → `local copy modified`;
   deleted file → `local file missing`; missing dir → all `local directory missing`;
   **CRLF local file whose LF digest matches → content, proving normalization**.
2. `computeDiff`: one case per state row; a modified file without before-content →
   `diffAvailable: false`, `reason` set, no `patch`; counts correct;
   `upstreamChanged === (modified+added+removed > 0)`; path-sorted output; duplicate
   paths in `currentFiles` → last wins (registry files[] treated as a set keyed by
   path, SHIP_REPORT assumption 7).

**Verify:** unit suite green; full gate.
**Commit:** `feat: before-side resolution and per-file diff states (R-17, D-13)`

### W3-T3 — the diff command [M] (R-17) — deps: W3-T2

**Files:** create `src/commands/diff.ts`; create `tests/unit/diff-cmd.test.ts`; modify
`src/output/errors.ts`; modify `src/main.ts`.

`errors.ts` addition (exact contract):

```ts
export const notPinned = (id: string) =>
  new CliError(`Skill '${id}' is not pinned. Run 'skillwarden pin <id>' first.`, 2);
```

`commands/diff.ts`:

```ts
export function runDiff(
  positionals: string[],
  flags: GlobalFlags,
  ctx: CommandContext,
): Promise<number>;
```

Flow: exactly one positional else `usage(...)` (exit 2); `parseSkillId` validates the
id shape; `readLockfile(ctx.cwd)` — null → `new CliError("No skillwarden.lock.json
here. Run 'skillwarden pin <id>' first.", 2)` (byte-identical to check's message);
id not in `lockfile.skills` → `notPinned(id)`; `buildApi(ctx, flags)` →
`client.skillDetail(id)` (NotFoundError → `skillNotFound(id)` exit 1; auth/offline/
network errors propagate the existing contracts); `current.files === null` → hash-only
report (spec degenerate case 1), exit 0; else `resolveBeforeSide(path.resolve(ctx.cwd,
pin.dir), pin.files)` → `computeDiff` → render.

Human rendering (via existing `colorsFor`): header
`<id>  pinned <hash8> (<pinnedAt>) -> current <hash8>`, summary counts line, then
per-file sections per the spec table; `+` green / `-` red / `@@` cyan. No-change case:
`<id>: no upstream changes since pin (<pinnedAt>)`.
`--json`: `{ id, pinnedAt, pinnedHash, currentHash, upstreamChanged, files: [...] }` —
`FileDiffEntry[]` verbatim, path-sorted.

**TDD ordering (fake fetch via injected `ctx.fetchImpl`, fixtures):**

1. Not-pinned id → exact message, exit 2; no lockfile → exact message, exit 2;
   malformed id → existing `Invalid skill id` contract, exit 2; two positionals →
   usage, exit 2.
2. Happy path vs `skill-detail.json` with matching temp workspace → exit 0,
   "no upstream changes".
3. Mutated detail (one file's contents changed, one added, one removed) → hunks
   rendered; counts line correct.
4. Tampered local file + mutated upstream → that file reports
   `content diff unavailable: local copy modified`, others still diff.
5. `files: null` detail (`skill-detail-nosnapshot.json`) → hash-only body, exit 0.
6. Tokenless online → `authMissing()` message, exit 4 (behaves like pin, D-10).
7. `--offline` with warm/cold cache → served / `offlineMiss` exit 3.
8. `--json` deep-equal snapshot for case 3.

`main.ts` wiring: `case 'diff'` in the dispatch switch (positional + global flags, no
extra options), `diff` entry in `COMMAND_HELP`, one line in `ROOT_HELP`'s command list:
`  diff <id>                Show upstream content changes for a pinned skill`.

**Verify:** new suites + full gate green; `node dist/cli.js diff --help` prints.
**Commit:** `feat: diff command with digest-proven before side (R-17)`

### W3-T4 — smoke extension, docs, decision row [S] (R-17) — deps: W3-T3

**Files:** modify `tests/integration/smoke.test.mjs`, `README.md`, `docs/PRD.md`,
`docs/DECISIONS.md`.

Smoke (after step 3's clean check, renumber comments): `diff` the pinned id → exit 0 +
`no upstream changes`; then point the fixture server at a mutated detail payload
(clone of `skill-detail.json` with one line changed in `files[0].contents` — server
route swap, and run with `--refresh` to bypass the cache) → exit 0 + output contains
`@@` and the changed line with `+`.

README: `diff` in the command reference + one quickstart line. PRD: add the SPEC-WP3
error rows to the error table; mark S-02 done in the stretch table (pointer to
SPEC-WP3). DECISIONS.md D-13 row: decision = digest-proven local before side with
per-file digest-level fallback; alternatives = pin-time content snapshots (lockfile
schema change or machine-local cache), digest-only report; rationale = never guesses,
no schema change, full diffs in the common case.

**Verify:** full gate; smoke green.
**Commit:** `test: diff coverage in smoke; docs and D-13 (R-17)`

## Self-review

R-17 → all four tasks: surface (T3), D-13 semantics (T2), rendering (T1), degenerate
cases (T2/T3), error rows (T3), json (T3), smoke/docs (T4). Signatures consistent:
`diffLines`/`renderUnified` (T1) consumed by `computeDiff` (T2) consumed by `runDiff`
(T3); `normalizeText` exported once (T1), used by T2. Version bump to 0.2.0 is out of
scope (release-cycle work).

## Non-goals

`--exit-code` gating; word-level diff; unpinned skills; patch application; pager.
