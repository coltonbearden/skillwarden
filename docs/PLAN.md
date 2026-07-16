# skillwarden — implementation plan

Execution order = task number order. Every task ends in an independently testable
deliverable (compiles, lints, and its tests pass).

## Architecture at a glance

Commands are thin orchestrators over pure cores. All I/O boundaries are injectable
through a single `CommandContext`, so unit tests never touch the real network, clock,
or home directory:

```ts
interface CommandContext {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetchImpl: typeof fetch;           // real fetch in prod, loopback/fake in tests
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  isTTY: boolean;
}
```

Test seams shipped as documented env vars: `SKILLWARDEN_API_BASE` (default
`https://skills.sh/api/v1`) and `SKILLWARDEN_CACHE_DIR` (default per-platform cache dir).

## Repo tree (target state)

```
skillwarden/
├── .env.example
├── .gitignore
├── .prettierrc.json
├── LICENSE                     (MIT)
├── README.md
├── eslint.config.js
├── package.json                (name skillwarden, bin → dist/cli.js, engines >=20.10)
├── package-lock.json
├── tsconfig.json               (strict; rewriteRelativeImportExtensions for .ts imports)
├── docs/                       (this phase's documents)
├── src/
│   ├── cli.ts                  entry: arg parsing, dispatch, exit-code mapping
│   ├── commands/
│   │   ├── scan.ts
│   │   ├── pin.ts
│   │   ├── check.ts
│   │   └── audit.ts
│   ├── api/
│   │   ├── types.ts            response types + structural validators
│   │   ├── cache.ts            disk response cache
│   │   └── client.ts           throttle, retries, cache/offline/refresh, error mapping
│   ├── core/
│   │   ├── discovery.ts        local skill discovery + fingerprinting
│   │   ├── lockfile.ts         read/write/upsert skillwarden.lock.json
│   │   ├── audit-model.ts      four-state modeling + regression compare
│   │   └── check-engine.ts     pure three-plane evaluation + policy
│   ├── output/
│   │   ├── errors.ts           CliError with exit codes; message constants
│   │   └── format.ts           tables, color, JSON emission
│   └── util/
│       └── paths.ts            platform dirs, posix-relative paths, home expansion
├── tests/
│   ├── fixtures/               (Phase 0 captures — already committed)
│   ├── helpers.ts              fixture loader, temp-dir skill builder, fake fetch/clock
│   ├── unit/
│   │   ├── paths.test.ts
│   │   ├── discovery.test.ts
│   │   ├── types.test.ts
│   │   ├── cache.test.ts
│   │   ├── client.test.ts
│   │   ├── audit-model.test.ts
│   │   ├── lockfile.test.ts
│   │   └── check-engine.test.ts
│   └── integration/
│       └── smoke.test.ts       spawns built CLI against loopback fixture server
└── dist/                       (gitignored tsc output)
```

Dev-loop note: tests run the `.ts` sources directly via Node ≥ 23.6 type stripping
(source imports carry `.ts` extensions; `rewriteRelativeImportExtensions` makes `tsc`
emit `.js`). The shipped `dist/` runs on Node ≥ 20.10. The build machine has Node 24.

## Tasks

### T1 — scaffolding and toolchain [S] (R-01 partial, R-10 partial) — deps: none

package.json (bin `skillwarden` → `dist/cli.js`, scripts `build`/`lint`/`format`/
`format:check`/`test`/`test:unit`/`test:integration`), tsconfig (strict, NodeNext,
`rewriteRelativeImportExtensions`), eslint flat config (js + typescript-eslint
recommended), prettier config, .gitignore (`dist/`, `node_modules/`, `.env`), MIT
LICENSE, `.env.example` (`SKILLS_SH_API_KEY=` + optional-comment). `src/cli.ts` v0:
prints name/version from a `version.ts` constant (single source; package.json reads are
brittle across bundling) and a help listing of the four commands; exits 2 with usage on
unknown input. Exact-pinned devDependencies; `npm install` produces the committed
package-lock.json.
**Interfaces produced:** npm scripts; `src/version.ts` → `export const VERSION`;
runnable `node dist/cli.js --version|--help`.
**Verify:** build + lint + format:check pass; `--version` prints; unknown flag exits 2.

### T2 — error and output primitives [S] (R-09 partial) — deps: T1

`output/errors.ts`: `class CliError extends Error { constructor(message, exitCode:
1|2|3|4) }` plus factory helpers named for the PRD error classes (`authMissing()`,
`authRejected()`, `rateLimited(retryAfter)`, `unavailable503()`, `network(detail)`,
`malformed(detail)`, `offlineMiss(resource)`, `badRequest(apiMsg)`, `skillNotFound(id)`)
— each emits the PRD's exact message string.
`output/format.ts`: `colorizer(enabled)` returning `{red,yellow,green,cyan,dim,bold}`;
`colorEnabled(flags, env, isTTY)` implementing `--no-color`/`NO_COLOR`/non-TTY;
`renderTable(header: string[], rows: string[][]): string[]` (padded columns, no wrap);
`printJson(ctx, obj)` (stable 2-space output).
**Interfaces produced:** as above, consumed by every later task.
**Verify:** unit assertions inline in later suites; lint/build green.

### T3 — platform paths [S] (R-04 partial) — deps: T1

`util/paths.ts`: `cacheDir(env, platform, home)` → `SKILLWARDEN_CACHE_DIR` override,
else win32 `%LOCALAPPDATA%\skillwarden\cache`, darwin `~/Library/Caches/skillwarden`,
else `$XDG_CACHE_HOME/skillwarden` or `~/.cache/skillwarden`; `toPosixRelative(from,
to)`; `samePath(a, b, platform)` (case-insensitive on win32).
**Interfaces produced:** `cacheDir`, `toPosixRelative`, `samePath`.
**Verify:** `tests/unit/paths.test.ts` — all three platforms via parameters, override
wins, missing LOCALAPPDATA falls back to home-relative.

### T4 — local discovery and fingerprinting [M] (R-02) — deps: T1, T3

`core/discovery.ts`:
`defaultRoots(cwd, home): string[]` — project `.claude/skills`, `.agents/skills`,
`skills`, `skills/.curated`, `skills/.experimental`, `skills/.system`; global
`~/.claude/skills`, `~/.cursor/skills`, `~/.codex/skills`.
`fingerprintDir(dir): Promise<Fingerprint>` where `Fingerprint = { files:
Record<posixRelPath, sha256hex>, combined: sha256hex }` — recursive, skips `.git`,
`node_modules`, `.DS_Store`; content digested after CRLF→LF normalization; combined =
sha256 of `"<path>\0<hex>\n"` sorted by path.
`discoverSkills(roots): Promise<LocalSkill[]>` where `LocalSkill = { slug, dir, realDir,
aliases: string[], fingerprint, frontmatter: { name?, description? } }` — a skill is a
directory directly containing `SKILL.md`; symlinks/junctions resolved with
`fs.realpath`, deduped by `samePath(realDir)` (first-seen dir wins, rest become
aliases); frontmatter parsed by regex from an optional leading `---` block, BOM
stripped.
**Interfaces produced:** `defaultRoots`, `discoverSkills`, `fingerprintDir`, types
`LocalSkill`, `Fingerprint`.
**Edge cases handled here:** nonexistent roots (skipped silently), empty roots, skill
dir with only SKILL.md, nested non-skill dirs, same slug in two roots (both returned —
disambiguation is pin's job), junction on win32 vs symlink elsewhere, unreadable file →
skill listed with stderr warning and dropped from fingerprint? No: unreadable file makes
the fingerprint unreliable → skill marked `unreadable: true` and excluded from tamper
verdicts (surfaced as a warning finding).
**Verify:** `discovery.test.ts` with temp dirs: layout matrix above, CRLF vs LF content
producing identical digests, symlink dedupe (junction on win32).

### T5 — API types and validators [S] (R-03 partial) — deps: T1, T2

`api/types.ts`: types `SkillSummary`, `LeaderboardResponse`, `SearchResponse`,
`CuratedResponse`, `SkillDetail`, `AuditEntry`, `AuditResponse`, `ApiErrorBody`;
validators `parseLeaderboard(unknown)`, `parseSearch`, `parseCurated`, `parseSkillDetail`,
`parseAudits`, `parseErrorBody` — structural checks on required fields/types, lenient to
extra fields; failure throws `malformed(detail)`. `isDuplicate` normalized to
`true | false | undefined` (absent = unknown); `hash`/`files` normalized to `| null`;
`audits: []` allowed; unknown providers/riskLevels passed through as strings.
**Interfaces produced:** all parse* functions + types.
**Verify:** `types.test.ts`: every Phase 0 fixture parses; mutated fixtures (missing
`id`, string `installs`, files as object) throw malformed.

### T6 — disk response cache [S] (R-04) — deps: T1, T3

`api/cache.ts`: `openCache(dir)` → `{ get(url): CacheEntry | null, put(url, entry):
void }`; `CacheEntry = { url, status: 200, fetchedAt: string, ttlSeconds: number, body:
unknown, rateLimit: { limit, remaining, reset } | null }`; freshness computed by caller
via `isFresh(entry, now)`. File per url: `sha256(url).json`, atomic write (tmp +
rename), corrupt/unreadable file → null; unwritable dir → put becomes no-op after one
stderr warning (flag on the handle).
**Interfaces produced:** `openCache`, `isFresh`, `CacheEntry`.
**Verify:** `cache.test.ts`: roundtrip, corrupt file → null, ttl 0 never fresh, atomic
overwrite, unwritable dir degrades (chmod trick skipped on win32 — simulate by passing a
file path as dir).

### T7 — API client [M] (R-03, R-04) — deps: T2, T5, T6

`api/client.ts`: `createClient(opts: { baseUrl, token?, cache, fetchImpl, sleep, now,
verbose, stderr, mode: 'online' | 'offline' | 'refresh' })` →
```ts
interface Client {
  leaderboard(view: 'all-time'|'trending'|'hot', page?, perPage?): Promise<LeaderboardResponse>;
  search(q: string, limit?): Promise<SearchResponse>;
  curated(): Promise<CuratedResponse>;
  skillDetail(id: SkillId): Promise<SkillDetail>;        // throws NotFoundError on 404
  skillAudits(id: SkillId): Promise<AuditResponse | 'unaudited'>;  // 404 → 'unaudited'
}
```
plus `parseSkillId(raw): SkillId` (`{source, slug, segments}`; GitHub = 3 path segments,
well-known = 2; anything else → CliError exit 2). Request pipeline: cache-fresh → serve;
offline → any entry else `offlineMiss`; online: throttle (≥1000 ms between request
starts via internal chain), fetch with `AbortSignal.timeout(10_000)` + UA + optional
bearer; 200 → validate, cache, return; 304-impossible (no conditional requests, keep
simple); 400 → badRequest; 401 → authMissing/authRejected by token presence; 404 →
NotFoundError (typed, caller decides); 429 → sleep `min(retryAfter ?? 30, 60)` s, retry
once, then rateLimited; 503 → backoff 1/2/4 s then unavailable503; network error/timeout
→ if a stale cache entry exists, serve it with stderr staleness warning, else
`network(detail)`; JSON parse failure → malformed. Query params clamped: perPage 1–500,
limit 1–200. Rate-limit headers logged via verbose stderr when present.
**Interfaces produced:** `createClient`, `parseSkillId`, `NotFoundError`, `SkillId`.
**Verify:** `client.test.ts` with fake fetch/sleep/clock: fresh-cache short-circuit,
refresh bypass, offline hit + miss, 429 sleeps then succeeds, 429×2 throws exit-3 error,
503×3 backoff sequence [1000,2000,4000], 401 both messages, 404 detail vs audit paths,
stale-fallback on ECONNREFUSED, throttle spacing with virtual clock, malformed JSON.

### T8 — audit modeling [S] (R-08 core) — deps: T5

`core/audit-model.ts`: `modelAudits(input: AuditResponse | 'unaudited'): AuditModel`
where `AuditModel = { overall: 'pass'|'warn'|'fail'|'unaudited', partners:
PartnerAudit[] }` — overall = worst of statuses (`fail` > `warn` > `pass`); empty
`audits[]` → `unaudited`. `compareAudits(pinned: PinnedAudits, current: AuditModel):
{ regressed: boolean, changes: string[] }` — regression = any partner status worsening,
riskLevel rising (NONE<LOW<MEDIUM<HIGH<CRITICAL, unknown levels never regress), a
previously-passing partner disappearing is *not* a regression (partner coverage
fluctuates), a new failing/warning partner is. `toPinnedAudits(model)` for the lockfile.
**Interfaces produced:** `modelAudits`, `compareAudits`, `toPinnedAudits`, types.
**Verify:** `audit-model.test.ts` on `audit-results.json`, `audit-mixed.json`,
`'unaudited'`, empty array, unknown provider/riskLevel, each regression rule.

### T9 — lockfile [S] (R-05) — deps: T3, T8

`core/lockfile.ts`: `readLockfile(cwd): Lockfile | null` (missing → null; invalid JSON
or wrong shape → CliError exit 2 naming the problem; `lockfileVersion > 1` → CliError
exit 2 "created by a newer skillwarden"); `writeLockfile(cwd, lf)` atomic, keys sorted,
2-space indent, trailing newline; `upsertPin(lf, id, pin)`. Types per PRD data model
(`PinnedSkill` with `snapshot: 'registry' | 'local'`).
**Interfaces produced:** `readLockfile`, `writeLockfile`, `upsertPin`, `Lockfile`,
`PinnedSkill`.
**Verify:** `lockfile.test.ts`: roundtrip stability (byte-identical rewrite), sorted
output, version guard, invalid shape message.

### T10 — scan command [S] (R-02 complete) — deps: T2, T4

`commands/scan.ts`: `runScan(flags, ctx): Promise<number>` — roots from `--root` (each
must exist: nonexistent explicit root → CliError exit 2; default roots skip silently),
discovery, human table (slug, location, files, digest12, name) with alias annotation +
`not in lockfile` marker when a lockfile exists, or `--json` `{ version, command:
"scan", skills: [...] }` sorted by slug.
**Interfaces produced:** `runScan`.
**Verify:** temp-dir test capturing ctx.stdout for table and json shapes; explicit
missing root exits 2.

### T11 — pin command [M] (R-06) — deps: T7, T8, T9, T10

`commands/pin.ts`: `runPin(flags, ctx)`:
ids from argv (each through `parseSkillId`) or `--all` (= lockfile keys; empty/missing
lockfile → CliError exit 2 with hint). For each id: local dir = lockfile's existing
`dir` if still present, else unique slug match among `discoverSkills(defaultRoots)`
(0 matches → CliError exit 1 `Skill '<id>' not found... no local directory named
'<slug>'` with `--dir` hint; >1 → CliError exit 2 listing candidates); `--dir` only
valid with exactly one id. Fetch `skillDetail` (404 → skillNotFound exit 1) +
`skillAudits`; `files` present → pin per-file sha256 of registry contents (CRLF-normalized
like local), `snapshot: 'registry'`; `files: null` → pin local fingerprint,
`snapshot: 'local'`; `isDuplicate` looked up from any cached leaderboard/search entry
containing the id (no dedicated network call — D-09). Write lockfile once after all ids;
per-id summary lines; partial failure: process remaining ids, exit with the worst code.
**Interfaces produced:** `runPin`.
**Verify:** loopback-fixture tests: fresh pin, re-pin `--all`, files-null path, audit-404
→ `audits: {}`, ambiguity error, not-found exit 1, no-token exit 4 message.

### T12 — check engine (pure) [M] (R-07 core) — deps: T4, T8, T9

`core/check-engine.ts`:
```ts
interface CheckInputs {
  lockfile: Lockfile;
  local: LocalSkill[];                        // discovery output
  registry: Map<string, SkillDetail | 'gone' | 'unknown'>;
  audits: Map<string, AuditModel | 'unknown'>;
  staleness: Map<string, number | null>;      // cache age seconds per id, null = live
}
evaluate(inputs): CheckReport                  // per-skill { integrity, registry, audit, duplicate } + notPinned[]
applyPolicy(report, conds: PolicyCond[]): { exit1: boolean, matched: string[] }
parsePolicy(raw: string): PolicyCond[]         // validates, 'none' exclusive, else CliError exit 2
```
Integrity: `dir-missing` | `modified` (any digest differs) | `missing-file` |
`extra-file` | `ok` — evaluated against pinned `files`; `unreadable` local skill →
integrity `unknown` + warning. Registry plane: pinned `registryHash` vs current `hash`
(`null` on either side → `unknown` with note) → `current`/`update-available`/`gone`/
`unknown`. Audit plane: `modelAudits` output + `compareAudits` regression marker.
Policy conds map: tamper ⇐ {dir-missing, modified, missing-file, extra-file}; drift ⇐
update-available; audit-fail ⇐ overall fail; audit-warn ⇐ overall warn; unaudited;
duplicate ⇐ isDuplicate true; gone.
**Interfaces produced:** `evaluate`, `applyPolicy`, `parsePolicy`, `CheckReport`.
**Verify:** `check-engine.test.ts` — the full matrix listed above plus: skill in lockfile
whose dir vanished, local skill not pinned, hash null at pin + null now, hash null → real
hash (unknown → but records new hash note), regression pass→fail, unaudited→fail, policy
`none`, invalid policy token.

### T13 — check command [M] (R-07 complete) — deps: T7, T12

`commands/check.ts`: `runCheck(flags, ctx)` — lockfile required (missing → CliError
exit 2 `No skillwarden.lock.json here. Run 'skillwarden pin <id>' first.`); discovery;
then per pinned id: no token & online-mode → registry/audits `unknown` (reason
`no-token`), one stderr notice total; else fetch via client with per-id error absorption
(NotFound → 'gone'; RateLimit/Unavailable/etc. abort the whole command with that error's
exit code — a half-checked report must not read as clean; offline miss → 'unknown').
Render: grouped human report with colored statuses + staleness annotations, summary
line, `--json` = CheckReport + policy verdict. Exit via `applyPolicy`.
**Interfaces produced:** `runCheck`.
**Verify:** loopback tests: clean run exit 0; tampered file + `--fail-on tamper` exit 1;
default policy ignores drift; offline-no-cache planes unknown yet exit 0 under default
policy; no-token notice; 429-exhausted aborts exit 3.

### T14 — audit command [S] (R-08 complete) — deps: T7, T8

`commands/audit.ts`: `runAudit(flags, ctx)` — single id arg (0 or >1 → usage exit 2);
fetch audits; `'unaudited'` → PRD message, exit 0; else per-partner table (provider,
status colored, riskLevel, auditedAt date, summary truncated to width, categories) +
overall verdict line; `--json` = full AuditModel.
**Interfaces produced:** `runAudit`.
**Verify:** loopback tests: mixed fixture rendering + overall fail; unaudited exit 0
message; not-found exit 1; --json shape.

### T15 — CLI wiring and help [M] (R-01, R-09 complete) — deps: T10, T11, T13, T14

`cli.ts` final: `util.parseArgs` per command (strict; unknown → usage exit 2), global
flag extraction, root help text (commands + global options + examples), per-command
`--help`, `--version`, ctx construction from process/env (fetch, sleep, now, isTTY),
`SKILLWARDEN_API_BASE` override, top-level handler: `CliError` → stderr message + its
code; unexpected error → stderr `Unexpected error: <message>` + exit 3. `main(argv,
ctx)` exported for tests; `cli.ts` executes only when run as entry.
**Interfaces produced:** `main(argv, ctx): Promise<number>`; the shipped binary surface.
**Verify:** unit: unknown command/flag → 2 with usage on stderr; `--help` for root and
each command; `--version`.

### T16 — integration smoke test [M] (all R-##, fixture-only) — deps: T15

`tests/integration/smoke.test.ts`: starts `node:http` loopback server mapping API routes
to Phase 0 fixtures (`/skills/vercel-labs/skills/find-skills` → `skill-detail.json`,
`/skills/audit/...` per-case, unaudited route → 404 with `error-404-audit.json`, plus a
429-then-200 route sequence); builds a temp workspace whose `.claude/skills/find-skills/
SKILL.md` matches the fixture contents byte-for-byte; spawns the **built** CLI
(`node dist/cli.js`) with `SKILLWARDEN_API_BASE`, `SKILLWARDEN_CACHE_DIR` → temp,
`SKILLS_SH_API_KEY=test-token`, `NO_COLOR=1`. Script: scan → pin → check (exit 0) →
tamper SKILL.md → check `--fail-on tamper` (exit 1, `modified` in output) → restore →
audit mixed (exit 0, `fail` verdict shown) → audit unaudited (exit 0, PRD message) →
kill server → check `--offline` (exit 0 from cache) → check online-no-server (stale
fallback notice, exit 0). Asserts exit codes and message fragments. No real network: the
only sockets are 127.0.0.1.
**Interfaces produced:** none (consumes everything).
**Verify:** `npm test` green with network disabled and no `SKILLS_SH_API_KEY` in the
parent env.

### T17 — README and ship docs [S] (R-10) — deps: T15, T16

README: what/why (60 seconds), install (`npx skillwarden`), quickstart session (real
commands mirroring the smoke test), authentication section (SKILLS_SH_API_KEY ← Vercel
OIDC token, exactly why, `vercel env pull` recipe, what works without it), command
reference (flags per command), config reference (env vars: SKILLS_SH_API_KEY,
SKILLWARDEN_CACHE_DIR, SKILLWARDEN_API_BASE, NO_COLOR), exit-code table, lockfile
format note + commit-it guidance, CI recipe (GitHub Actions step), limitations
(registry requires a token today; audit coverage varies).
**Verify:** Phase 5 walks it literally.

### T18 — final gate [S] (R-10) — deps: T17

`npm run build && npm run lint && npm run format:check && npm test` all green;
`npm pack --dry-run` lists only intended files (`files` allowlist in package.json:
dist, README, LICENSE); lockfile committed; every task's conventional commit exists.

## Edge-case register (component → cases)

- **discovery:** CRLF/LF equivalence; BOM before frontmatter; missing frontmatter; same
  slug in two roots; symlink+junction dedupe; unreadable file → `unknown` integrity;
  skipped default roots vs erroring explicit `--root`; `.git`/`node_modules` exclusion.
- **client:** Retry-After absent (30 s default) / huge (capped 60 s); 429 twice → exit 3;
  503×3 then exit 3; timeout → network error; stale-cache fallback on network error;
  offline + no entry → exit 3; malformed JSON on 200; rate-limit headers absent (never
  crash — observed on real 401); per_page clamp 1–500, limit clamp 1–200; error body
  that is not JSON (use status-class message with raw snippet).
- **types:** `hash: null`; `files: null`; `files: []` (valid, empty skill snapshot);
  `isDuplicate` absent vs true; `audits: []` → unaudited; unknown provider / riskLevel
  strings; empty search `data: []`.
- **lockfile:** version > 1; invalid JSON; unknown extra keys preserved? No — rewritten
  files contain only known keys (documented); byte-stable rewrite when nothing changed.
- **check-engine:** every integrity state; drift with null hashes on either side;
  pass→fail and unaudited→fail regressions; partner disappearance ≠ regression; policy
  `none` + invalid tokens; duplicate flag only when `isDuplicate === true`.
- **pin:** ambiguity across roots; `--dir` with multiple ids → usage error; audit 404 →
  `audits: {}`; snapshot local vs registry; partial multi-id failure keeps going, worst
  exit code wins.
- **cli:** unknown command; unknown flag per command; `--json` + human warnings kept on
  stderr; non-TTY color off.

## Test plan

Unit (node:test, fake fetch/clock/fs-temp): paths, discovery, types, cache, client,
audit-model, lockfile, check-engine — the pure core carries the assertion weight.
Command-level tests (in-process `main()` with injected ctx + loopback server where
network is involved): scan, pin, check, audit happy + error paths.
One end-to-end smoke (T16) over the built artifact, fixture-only, offline-capable.
Phase 5 mandates re-verified: 429 path (client test + smoke sequence), unaudited 404
(audit command test + smoke), invalid input (cli tests).

## Scope gate

Estimates: S×9 + M×6 ≈ comfortably within this session at full quality, including tests
written alongside each task. No R-## demoted. Stretch S-01…S-06 untouched. If reality
disagrees mid-build, the first demotion candidates are R-06's `isDuplicate` cache-only
lookup (already minimal by D-09) and scan's alias annotation — both logged if taken.

## Self-review (per Phase 3 gate)

1. R-01→T1+T15, R-02→T4+T10, R-03→T5+T7, R-04→T3+T6+T7, R-05→T9, R-06→T11, R-07→T12+T13,
   R-08→T8+T14, R-09→T2+T15, R-10→T1+T17+T18. All MVP R-## covered; no task exists that
   serves no R-##.
2. No placeholder language; every "later" is a numbered task with a deliverable.
3. Names/signatures consistent across tasks (`CommandContext`, `createClient`,
   `discoverSkills`, `evaluate`/`applyPolicy`, `run<Cmd>` returning exit codes;
   `main(argv, ctx)`).
