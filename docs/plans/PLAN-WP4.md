# WP-4 — `cache info | clear`: implementation plan

> **For agentic workers:** execute via superpowers:subagent-driven-development — fresh
> subagent per task, TDD inside each task (failing test → minimal code → green → gate →
> commit). Task text + SPEC-WP4 slices are the whole context a subagent gets.

**Goal:** `skillwarden cache info` (location, entries, size, freshness) and
`skillwarden cache clear --yes` — per `docs/specs/SPEC-WP4.md` (R-18, R-19).

**Architecture:** stats/clear primitives live beside the cache implementation in
`src/api/cache.ts` (same module owns the entry format); `commands/cache.ts` is a thin
renderer. Never network. Targets v0.2.0 — implemented after the v0.1.0 tag.

## Global constraints

- Zero runtime dependencies; suite green offline/tokenless at every commit.
- `clear` deletes only `^[0-9a-f]{64}\.json$` entries + orphaned `*.json.tmp` — never
  the directory, never recursive, never other names.
- No interactive prompt ever; `--yes` is the only confirmation (D-14).
- New messages/exit codes are exact contracts (SPEC-WP4 error table).

Execution order = task number order.

### W4-T1 — cache stats and clear primitives [S] (R-18, R-19) — deps: none

**Files:** modify `src/api/cache.ts`; extend `tests/unit/cache.test.ts`.

```ts
export interface CacheStats {
  exists: boolean;
  entries: number; // files parsing as valid CacheEntry
  corrupt: number; // *.json failing isCacheEntry / JSON.parse
  sizeBytes: number; // total bytes of all *.json in the dir
  fresh: number; // isFresh(entry, now)
  expired: number; // entries - fresh
  oldest: string | null; // min fetchedAt among valid entries
  newest: string | null; // max fetchedAt
}
export function cacheStats(dir: string, now: Date, warn: (msg: string) => void): CacheStats;

export interface ClearResult {
  cleared: number;
  freedBytes: number;
  failed: number; // deletions that threw (warned by caller)
}
const ENTRY_FILE = /^[0-9a-f]{64}\.json$/;
export function clearCache(dir: string, warn: (msg: string) => void): ClearResult;
```

`cacheStats`: missing dir (ENOENT) → `exists: false`, zeros, nulls, silent; dir that
exists but cannot be read (EACCES et al.) → same zeros plus exactly one `warn(...)` in
the existing cache-degradation tone (SPEC-WP4: unreadable directory warns, exit 0).
`clearCache`: deletes `ENTRY_FILE` matches and `*.json.tmp`; per-file failure →
`warn(...)`, counted in `failed`, keep going; missing dir → all-zero result.

**TDD ordering:**

1. `cacheStats`: missing dir → exists false/zeros; empty dir; 2 fresh + 1 expired via
   a fixed `now` against entries written with known `fetchedAt`/`ttlSeconds`; corrupt
   `deadbeef….json` (invalid JSON) counted `corrupt`, not `entries`; non-entry
   `notes.json` counted `corrupt` (it is a `*.json` that isn't an entry), its bytes in
   `sizeBytes`; `oldest`/`newest` correct.
2. `clearCache`: only hash-named files + `.json.tmp` deleted — planted `README.txt` and
   `notes.json` survive; `freedBytes` = sum of deleted sizes; missing dir → zeros;
   repeat call → zeros ("already empty" is the caller's message).

**Verify:** `node --test tests/unit/cache.test.ts` green; full gate.
**Commit:** `feat: cache stats and safe clear primitives (R-18, R-19)`

### W4-T2 — the cache command [M] (R-18, R-19) — deps: W4-T1

**Files:** create `src/commands/cache.ts`; create `tests/unit/cache-cmd.test.ts`;
modify `src/main.ts`.

```ts
export function runCache(
  positionals: string[], // ['info'] | ['clear']
  flags: GlobalFlags & { yes: boolean },
  ctx: CommandContext,
): Promise<number>;
```

`main.ts` wiring: `case 'cache'` with extra option `yes: { type: 'boolean', default:
false }`; reject `--offline`/`--refresh` exactly like scan does
(`throw usage('cache is always offline; --offline/--refresh do not apply.')`);
missing/unknown subcommand → `usage("cache requires a subcommand: info or clear.")` /
`usage("Unknown cache subcommand '<x>'.")` (exit 2). `cache` entry in `COMMAND_HELP`
(subcommands + `--yes`) and one `ROOT_HELP` line:
`  cache info|clear         Inspect or empty the response cache (offline)`.

`info` flow: `cacheDir(ctx.env, os.platform(), ctx.home)` → `cacheStats(dir,
ctx.now())` → human block (location / entries / corrupt (when > 0) / size humanized
`12.4 kB` / `fresh N, expired M` / oldest+newest ISO, omitted when empty) or `--json`
`{ location, exists, entries, corrupt, sizeBytes, fresh, expired, oldest, newest }` —
keys always present. Exit 0 always (including missing dir).

`clear` flow: stats first (for live `<n>`/`<size>`); without `--yes` → stderr
`cache clear deletes <n> cached responses (<size>). Re-run with --yes to confirm.`,
exit 2, nothing deleted. With `--yes`: empty/missing → stdout `cache is already
empty`, exit 0; else `clearCache` → stdout `cleared <n> cached responses (<size>) from
<location>`, exit 0; all deletions failed (`cleared 0`, `failed > 0`) → stderr
`Could not clear the cache at <location> (<first warn detail>).`, exit 3. `--json` (with
`--yes`): `{ location, cleared, freedBytes, failed }`.

**TDD ordering (temp dirs via `SKILLWARDEN_CACHE_DIR` in `ctx.env`):**

1. Wiring: `cache` alone → usage exit 2; `cache frobnicate` → usage exit 2;
   `cache info --offline` → usage exit 2 (scan-style message).
2. `info`: missing dir → zeros exit 0; populated dir (2 fresh + 1 expired + 1 corrupt,
   fake `ctx.now`) → human block lines; `--json` deep-equal.
3. `clear` without `--yes` → exact refusal on stderr, exit 2, files intact.
4. `clear --yes` → planted non-entry files survive, entries+`.tmp` gone, report line,
   exit 0; again → `cache is already empty`, exit 0.
5. `--json` shape for clear.

**Verify:** new suite + full gate green; `node dist/cli.js cache --help` prints.
**Commit:** `feat: cache info and clear subcommands (R-18, R-19)`

### W4-T3 — smoke touch, docs, decision row [S] (R-18, R-19) — deps: W4-T2

**Files:** modify `tests/integration/smoke.test.mjs`, `README.md`, `docs/PRD.md`,
`docs/DECISIONS.md`.

Smoke: after the offline-check step (cache is warm), assert `cache info` exit 0 and
stdout matches `/entries:\s+[1-9]/`; then `cache clear` (no `--yes`) → exit 2 leaving
the cache intact (the later stale-fallback step still works — ordering guard).

README: `cache` in the command reference (`info`, `clear --yes`, the no-prompt
contract). PRD: append the two SPEC-WP4 error rows to the error table; mark S-05 done
in the stretch table (pointer to SPEC-WP4). DECISIONS.md D-14 row: decision =
`cache clear` refuses without `--yes`, no TTY prompt, refusal shows live count/size
(dry-run doubles as confirmation); alternatives = interactive TTY prompt with `--yes`
for scripts, no confirmation at all; rationale = deterministic in CI and terminals
alike (nothing hangs), mirrors `npm cache clean --force`, and the throwaway-state risk
is low but a mis-set `SKILLWARDEN_CACHE_DIR` makes name-filtered deletion + explicit
confirmation the safe default.

**Verify:** full gate; smoke green.
**Commit:** `test: cache coverage in smoke; docs and D-14 (R-18, R-19)`

## Self-review

R-18 → W4-T1 (stats) + W4-T2 (info rendering/json) + W4-T3 (docs); R-19 → W4-T1
(clear primitive + name filter) + W4-T2 (confirmation contract, exit codes) + W4-T3.
Signatures consistent: `cacheStats`/`clearCache` (T1) consumed by `runCache` (T2);
`ENTRY_FILE` filter tested in both T1 and T2 (planted-file survival). Version bump to
0.2.0 out of scope.

## Non-goals

Selective eviction; cache warming; TTL override (S-03); touching anything but the
response cache.
