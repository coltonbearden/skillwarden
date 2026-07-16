# SPEC-WP3 — `diff <id>`: what changed upstream before you re-pin (S-02)

## Problem

`check` tells you _that_ upstream content drifted (`update-available`); nothing shows
_what_ changed. Re-pinning drift you haven't read is exactly the blind trust skillwarden
exists to remove. `diff <id>` renders the content change between the pinned state and
the current registry state so the re-pin decision is informed.

## Open question — the "before" side (resolved)

The lockfile pins per-file **digests**, not contents (R-05), so there is no stored
"before" content. Options considered:

- **(a) Local files, digest-proven** — when a file's local digest (CRLF-normalized,
  same pipeline as `check`) equals its pinned digest, the local content _is_ the pinned
  content by definition, and can serve as the before side. Per-file, not per-skill: even
  in a tampered skill, untampered files still diff cleanly.
- **(b) Content snapshot cached at pin time** — store contents in the lockfile
  (schema change; violates "lockfileVersion stays 1", bloats a committable file) or in
  the machine-local cache (not committable, evictable, absent on any other machine —
  the diff would silently work on the pinning machine only).
- **(c) Digest-level report only** — always correct, never shows content. Wastes the
  fact that the detail endpoint returns full `files[].contents`.

**Decision (log as D-13 at execution): (a) with (c) as per-file fallback.** For each
file, the before side is the local copy **iff its digest matches the pin**; otherwise
that file degrades to a digest-level status with an explicit reason. Never guesses,
needs no schema change, no new storage, and gives full content diffs in the common case
(clean checkout + upstream drift).

## Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-17 | `skillwarden diff <id>` renders upstream content changes for a pinned skill per the CLI surface, semantics (D-13 before side, CRLF→LF-normalized comparison, per-file states), degenerate cases, error-contract additions, and exit-code rules specified below. Rendering is stdlib-only unified diff (Myers line diff, 3 context lines); `--json` emits the documented deterministic shape. |

## CLI surface

```
skillwarden diff <id>          Show upstream content changes for a pinned skill

Options: --json, --no-color, --verbose, --offline, --refresh   (existing semantics)
```

Exactly one `<id>`, which must exist in `skillwarden.lock.json`. Network command: fetches
the current detail (gated route — same auth requirements as `pin`), honoring cache,
`--offline`, and `--refresh` per R-03/R-04.

## Semantics

Let `pinned.files` be the lockfile digest map and `current` the fetched `SkillDetail`.

Per-file states over `union(paths(pinned.files), paths(current.files))`:

| State       | Condition                                   | Rendering (human)                                                                                                       |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `unchanged` | digest of current contents == pinned digest | counted in summary line only                                                                                            |
| `modified`  | both sides exist, digests differ            | unified diff (below) when before side available, else one line: `modified: <path> (content diff unavailable: <reason>)` |
| `added`     | in current only                             | unified diff against empty (full `+` body)                                                                              |
| `removed`   | in pinned only                              | `removed: <path>` — before content shown as full `-` body when the local copy is digest-proven, else name only          |

Before-side resolution per file (D-13): local file at `pinned.dir` whose
CRLF-normalized digest equals the pinned digest → use its normalized content. Reasons
rendered when unavailable: `local copy modified`, `local file missing`,
`local directory missing`.

Both sides are compared and rendered **CRLF→LF-normalized** (the digest pipeline's
normalization, D-07/HANDOFF invariant 7) — line-ending-only differences cannot appear.

Degenerate cases:

- `current.files == null` (registry has no snapshot): no content comparison possible.
  Render header + `registry has no content snapshot; comparing hashes only:` with
  pinned vs current `hash` verdict. Exit 0 (data state).
- `pinned` and `current` hashes equal and all digests match: `<id>: no upstream changes
since pin (<pinnedAt>)`. Exit 0.
- Skill 404 from registry: existing `pin`/`audit` contract row applies
  (`Skill '<id>' not found in the registry.`, exit 1).

Header (human output): `<id>` + `pinned <registryHash-short> (<pinnedAt>)` vs
`current <hash-short>` + per-state file counts. Diff hunks use standard unified format,
3 context lines, `+`/`-` colored per existing R-09 color rules. Rendering is
stdlib-only: a Myers line-diff implemented in `src/core/`.

`--json`: `{ id, pinnedAt, pinnedHash, currentHash, upstreamChanged, files: [{ path,
status, diffAvailable, reason?, patch? }] }` — files sorted by path, `patch` = unified
diff text, deterministic ordering (R-09).

## Error contract additions (PRD table format)

| Class                   | User-facing message (stderr)                                                                  | Exit |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---- |
| `diff` with no lockfile | `No skillwarden.lock.json here. Run 'skillwarden pin <id>' first.` (existing message, reused) | 2    |
| `diff <id>` not pinned  | `Skill '<id>' is not pinned. Run 'skillwarden pin <id>' first.`                               | 2    |
| `diff` malformed id     | existing `Invalid skill id` contract                                                          | 2    |

All network/auth/offline rows (401 with/without key, 404, 429, 503, offline cache miss)
reuse the existing PRD table verbatim — `diff` behaves like `pin` (it cannot proceed
without the gated detail route; 401-without-token is a hard exit 4, not a degraded
plane, per D-10).

## Exit codes

`0` success — including "no changes", "hashes only", and diffs of any size shown.
Differences do **not** produce exit 1; gating is `check`'s job (see non-goals).

## Test expectations

- Diff engine unit tests (pure): added / removed / modified / unchanged; identical
  content; empty before; empty after; hunk boundaries and 3-line context; determinism.
- Before-side resolution tests: digest-proven local content used; tampered local file →
  `content diff unavailable: local copy modified`; missing file / missing dir reasons;
  CRLF local + LF registry content → `unchanged` (normalization).
- Command tests with fake fetch + fixtures: full flow against `skill-detail.json` and a
  mutated variant; `files: null` hash-only path; not-pinned and no-lockfile errors;
  `--json` shape snapshot; `--offline` served from cache; 401 tokenless exit 4.
- Fixture-server smoke extension: one `diff` invocation after `pin` (no changes) and
  one after serving mutated detail content (renders a hunk).

## Non-goals

- No gating/`--exit-code` (use `check --fail-on drift`); no word-level or intra-line
  diff; no diffing unpinned or uninstalled skills; no patch application / auto-repin;
  no pager integration.
