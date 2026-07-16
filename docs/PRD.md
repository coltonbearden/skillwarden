# skillwarden — PRD

`npm audit` for agent skills: pin, verify, and audit-gate the skills your coding agents execute.

## Problem statement

Agent skills are instruction packages that tools like Claude Code _execute with your
credentials and filesystem_. The official `npx skills` CLI installs them well, but after
installation nothing on the machine notices when: (a) an installed skill's files are
modified locally (tampering, bad merges, curious teammates), (b) the upstream skill changes
content (supply-chain drift), (c) a security auditor flips a skill to _warn_/_fail_, or
(d) what you installed is a fork shadowing a canonical skill. The official CLI writes no
lockfile, so there is no record of what "known-good" even was.

**Target user:** a developer running Claude Code (or any skills-consuming agent) daily,
personally or with a team/CI, who wants the same hygiene loop they already have for npm
packages: lock what you installed, verify it hasn't changed, gate on security status.

## Product shape (one session)

```console
$ npx skillwarden scan                          # what's installed on this machine? (offline)
$ npx skillwarden pin anthropics/skills/frontend-design   # snapshot registry state into skillwarden.lock.json
$ npx skillwarden check --fail-on tamper,audit-fail       # daily/CI gate; exit 1 on findings
$ npx skillwarden audit mattpocock/skills/grill-me        # per-partner security report for any skill
```

## Requirements

### MVP

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | CLI skeleton: `skillwarden` with subcommands `scan`, `pin`, `check`, `audit`; global flags `--json`, `--no-color`, `--verbose`, `--help`, `--version`; network commands additionally accept `--offline` and `--refresh`. Unknown command/flag → usage message, exit 2. Root `--help` lists all commands; each subcommand has its own `--help`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R-02 | Local discovery (`scan`): find installed skills (a directory directly containing `SKILL.md`) under default roots — project: `.claude/skills`, `.agents/skills`, `skills` (plus `skills/.curated`, `skills/.experimental`, `skills/.system`); global: `~/.claude/skills`, `~/.cursor/skills`, `~/.codex/skills` — or under explicit repeatable `--root <path>` (replaces defaults). Resolve symlinks and dedupe by real path (the official CLI symlinks by default), listing alias locations. Fingerprint each skill: per-file SHA-256 over the skill dir (relative path + content, CRLF→LF normalized), plus a combined digest. Extract `name`/`description` from SKILL.md frontmatter when present. Human table + `--json`. Fully offline; never touches the network.                                                                                                                                                      |
| R-03 | API client: base `https://skills.sh/api/v1`; bearer token from `SKILLS_SH_API_KEY` iff set; `User-Agent: skillwarden/<version>`; 10 s timeout per request; client-side throttle ≥1000 ms between request starts (≤60/min); honors `Cache-Control` via R-04; on 429 sleeps `min(Retry-After, 60)` s and retries once; on 503 retries with backoff 1 s/2 s/4 s; no retry on other statuses or timeouts; parses the `{error, message}` envelope, keyed on HTTP status only; `--verbose` prints `X-RateLimit-Remaining`/`Limit` when present (tolerates absence).                                                                                                                                                                                                                                                                                                                                                               |
| R-04 | Disk response cache: per-URL JSON entries under the platform cache dir (Windows `%LOCALAPPDATA%\skillwarden\cache`, Linux `$XDG_CACHE_HOME/skillwarden` else `~/.cache/skillwarden`, macOS `~/Library/Caches/skillwarden`). Only 200 responses cached, TTL from `Cache-Control: max-age` (fallback 60 s). Fresh entry → served without a request; expired → refetch (on network failure, fall back to stale with a warning); `--refresh` → bypass and refetch; `--offline` → serve any entry regardless of age, flagged with its age; corrupt entry → treated as a miss and overwritten.                                                                                                                                                                                                                                                                                                                                    |
| R-05 | Lockfile `skillwarden.lock.json` in the working directory (committable, deterministic key order, `lockfileVersion: 1`): per skill — registry `id`, local dir (relative), pin timestamp, registry `hash`, per-file SHA-256 digests from registry `files[]` (not contents), `installs`, `isDuplicate` (when known), and an audit snapshot (per-partner status + riskLevel + auditedAt). Handles `hash: null`/`files: null` (pinned as `snapshot: unavailable`; tamper checking then uses local fingerprint captured at pin time).                                                                                                                                                                                                                                                                                                                                                                                             |
| R-06 | `pin <id>...` and `pin --all`: for each `{source}/{slug}` id, locate the local dir whose folder name equals the slug across scan roots (explicit `--dir <path>` override when ambiguous or unmatched; ambiguity without `--dir` is an error listing candidates); fetch detail + audits (+ leaderboard/search hit for `isDuplicate` when available in cache or budget); write/update the lockfile. `--all` re-pins every entry already in the lockfile. Audit 404 recorded as `unaudited`, not an error. Missing token → exit 4 with guidance; `--offline` pins from cache if possible, else exit 3.                                                                                                                                                                                                                                                                                                                         |
| R-07 | `check`: compares three planes and reports per skill — **integrity** (local files vs pinned digests → `ok`/`modified`/`missing-file`/`extra-file`/`dir-missing`), **registry** (live/cached `hash` vs pinned → `current`/`update-available`; skill 404 → `gone`; no token and no cache → `unknown`), **audits** (live/cached vs pinned → worst-of `pass`/`warn`/`fail`, `unaudited`, plus `regressed` marker when any partner worsened or riskLevel rose). Reports `isDuplicate` skills. Policy: `--fail-on <cond,...>` over `tamper`, `drift`, `audit-fail`, `audit-warn`, `unaudited`, `duplicate`, `gone`, `none`; default `tamper,audit-fail`. Exit 0 clean-under-policy, 1 findings at/above policy. Degrades cleanly offline/tokenless: integrity always runs; registry/audit planes marked `unknown`/stale with age, never crash. Skills on disk but not in the lockfile are listed as `not-pinned` (informational). |
| R-08 | `audit <id>`: standalone per-skill security report (installed or not): per partner — provider, status (colored), riskLevel, summary, auditedAt, categories (Trust Hub); overall verdict = worst status across partners. Audit 404 → "not yet audited" explanation, exit 0. `--json` emits the full model including the four-state overall (`pass`/`warn`/`fail`/`unaudited`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R-09 | Output layer: aligned human-readable tables; ANSI color disabled by `--no-color`, `NO_COLOR` env, or non-TTY stdout; every command supports `--json` with stable, documented, deterministically-ordered shapes (findings sorted by id); human output to stdout, warnings/progress to stderr.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R-10 | Packaging & docs: npm package `skillwarden` (bin → compiled `dist/cli.js`, Node `>=20.10`), README (setup, copy-pasteable usage, config reference, exit codes), `.env.example` containing `SKILLS_SH_API_KEY=` with "optional" comment, MIT license, exact-pinned dev deps with committed `package-lock.json`, zero runtime deps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Stretch

| ID   | Requirement                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-01 | `brief`: morning digest — top `hot` movers (`installsYesterday`, `change`), `trending` entrants, audit changes across the lockfile, duplicate alerts.             |
| S-02 | `diff <id>`: unified diff of pinned per-file digests vs current registry `files[]` contents (refetched), showing exactly what changed upstream before you re-pin. |
| S-03 | Config file `skillwarden.config.json` (roots, default `--fail-on`, cache TTL override).                                                                           |
| S-04 | `scan --identify`: suggest registry ids for unmapped local skills via `/skills/search?q=<slug>`.                                                                  |
| S-05 | `cache` subcommand: `info` (location, entry count, size), `clear`.                                                                                                |
| S-06 | Curated cross-reference: mark lockfile skills that are in the official curated set.                                                                               |

## CLI interface

```
skillwarden <command> [options]

Commands:
  scan                     Inventory locally installed skills (offline)
  pin <id>... | --all      Snapshot registry state for installed skills into the lockfile
  check                    Verify integrity, drift, and audit status against the lockfile
  audit <id>               Show security audit report for any registry skill

Global options:
  --json          Machine-readable output on stdout
  --no-color      Disable ANSI color (also: NO_COLOR env, non-TTY)
  --verbose       Progress + rate-limit details on stderr
  --version       Print version
  --help          Print help

Network options (pin, check, audit):
  --offline       Use cached responses only; never touch the network
  --refresh       Ignore cache freshness; refetch everything

scan options:
  --root <path>   Scan this root instead of the defaults (repeatable)

pin options:
  --all           Re-pin every skill already in the lockfile
  --dir <path>    Explicit local directory for a single <id>

check options:
  --fail-on <c,...>  Conditions that cause exit 1: tamper, drift, audit-fail,
                     audit-warn, unaudited, duplicate, gone, none
                     (default: tamper,audit-fail)
```

Example invocations:

```console
$ skillwarden scan --json | jq '.skills[].slug'
$ skillwarden pin vercel-labs/skills/find-skills anthropics/skills/frontend-design
$ skillwarden pin --all --refresh
$ skillwarden check --fail-on tamper,audit-fail,drift
$ skillwarden check --offline --json
$ skillwarden audit mattpocock/skills/grill-me
$ SKILLS_SH_API_KEY=$(vercel env pull --yes >/dev/null && grep VERCEL_OIDC_TOKEN .env.local | cut -d= -f2) skillwarden pin --all
```

### Exit codes

| Code | Meaning                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success; includes benign data states (clean `check`, `audit` of an unaudited skill)                                                                                 |
| 1    | `check` findings at/above `--fail-on` policy; or the requested skill id does not exist (404) for `pin`/`audit`                                                      |
| 2    | Usage error: unknown command/flag, malformed id, invalid `--fail-on` value, API 400                                                                                 |
| 3    | Unavailable: network failure/timeout, 429 persisting after one waited retry, 503 after 3 backoff attempts, malformed API response, `--offline` with no usable cache |
| 4    | Auth: network operation attempted without `SKILLS_SH_API_KEY`, or the API rejected the token (401)                                                                  |

## Data model

### Lockfile — `./skillwarden.lock.json`

```jsonc
{
  "lockfileVersion": 1,
  "pinnedAt": "2026-07-15T18:00:00.000Z", // last write
  "skills": {
    "anthropics/skills/frontend-design": {
      // key = registry id, sorted
      "dir": ".claude/skills/frontend-design", // relative, forward slashes
      "pinnedAt": "2026-07-15T18:00:00.000Z",
      "registryHash": "sha256hex | null", // API `hash` verbatim
      "installs": 668333,
      "isDuplicate": false, // only when learned; absent = unknown
      "snapshot": "registry | local", // local = API had files:null; digests below are of local files at pin time
      "files": { "SKILL.md": "sha256hex", "reference.md": "sha256hex" }, // sorted by path
      "audits": {
        // per-partner snapshot; {} = unaudited at pin
        "socket": { "status": "pass", "riskLevel": "NONE", "auditedAt": "..." },
      },
    },
  },
}
```

Written atomically (temp file + rename), keys sorted, 2-space indent, trailing newline —
diff-friendly for review in PRs.

### Response cache — platform cache dir (see R-04)

One file per URL: `<sha256(url)>.json`:

```jsonc
{
  "url": "https://skills.sh/api/v1/skills/anthropics/skills/frontend-design",
  "status": 200,
  "fetchedAt": "2026-07-15T18:00:00.000Z",
  "ttlSeconds": 300, // from Cache-Control max-age, fallback 60
  "body": {/* verbatim JSON body */},
  "rateLimit": { "limit": 600, "remaining": 594, "reset": 31 }, // null fields when headers absent
}
```

Freshness rule: `fetchedAt + ttlSeconds > now` → fresh. Expired entries are kept (they
serve `--offline` and network-failure fallback) and overwritten on successful refetch.
Only status-200 bodies are ever cached. Cache dir is created lazily; unwritable cache
degrades to uncached operation with one stderr warning, never a crash.

### Local fingerprinting

A skill dir's file set = every regular file under it (recursive), excluding `.git`,
`node_modules`, `.DS_Store`. Digest = SHA-256 of content with CRLF→LF normalization
(prevents false tampering from git `autocrlf` on Windows). Combined digest = SHA-256 of
`"<path>\0<hex>\n"` lines sorted by path — deterministic across platforms. The registry's
own `hash` algorithm is undocumented, so local digests are never compared to registry
`hash`; see D-07.

## Error handling

Messages are exact contracts (verified in Phase 5). `<id>`, `<n>`, `<detail>` interpolate.

| Class                            | User-facing message (stderr)                                                                                                                                           | Exit                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 400                              | `skills.sh rejected the request (400): <api message>`                                                                                                                  | 2                                            |
| 401, no key set                  | `This command needs registry access. Set SKILLS_SH_API_KEY to a Vercel OIDC token (see README > Authentication). Offline features: scan, check --offline.`             | 4                                            |
| 401, key set                     | `skills.sh rejected the token in SKILLS_SH_API_KEY (401). Vercel OIDC tokens expire after ~12h — refresh with: vercel env pull`                                        | 4                                            |
| 404 skill (`pin`/`audit` target) | `Skill '<id>' not found in the registry.`                                                                                                                              | 1                                            |
| 404 skill (during `check`)       | finding `gone`, message in report: `no longer in the registry`                                                                                                         | policy                                       |
| 404 audit                        | `No audits yet for '<id>' — audits are generated automatically shortly after a skill's first install.` (stdout; it is a data state)                                    | 0                                            |
| 429 (after one waited retry)     | `Rate limited by skills.sh (429). Try again in <Retry-After>s.`                                                                                                        | 3                                            |
| 503 (after 3 backoff attempts)   | `skills.sh is temporarily unavailable (503). Tried 3 times over 7s.`                                                                                                   | 3                                            |
| Network failure / timeout        | `Could not reach skills.sh (<detail>). Check connectivity, or use --offline to run from cache.`                                                                        | 3                                            |
| Malformed response               | `skills.sh returned an unparseable response (<detail>).`                                                                                                               | 3                                            |
| `--offline`, cache miss          | `No cached data for <resource>. Run once without --offline to populate the cache.` → for `check`: affected planes report `unknown (no cache)`, command still completes | 3 (direct fetch commands) / policy (`check`) |

`check` never hard-fails because one skill errored: per-skill errors become findings;
only total inability to proceed (e.g. no lockfile: `No skillwarden.lock.json here. Run
'skillwarden pin <id>' first.`, exit 2) stops it.

## API client behavior (summary of R-03/R-04)

- Timeout 10 s (`AbortSignal.timeout`), applies per attempt.
- Throttle: ≥1000 ms between request starts, process-wide (≤60/min — one tenth of the
  documented authenticated limit; polite and far from 429s).
- Cache per R-04; requests consult cache before the network, always.
- 429: sleep `min(Retry-After ?? 30, 60)` s, retry once. 503: retry ×3, 1/2/4 s backoff.
  Nothing else retries.
- Rate-limit headers surfaced under `--verbose`; absence tolerated (observed absent on 401).
- All request URLs use the apex host `https://skills.sh`; redirects followed.

## Authentication

Optional-by-design: `SKILLS_SH_API_KEY` env var, holding whatever bearer the API accepts —
today a Vercel OIDC token (the API's only documented scheme; see `API_SURFACE.md` and
D-03). Never persisted, never logged, never echoed; sent only as `Authorization: Bearer`.
Without it: `scan` is fully functional, `check` runs its integrity plane plus any cached
registry/audit data, and `pin`/`audit` explain exactly what to set. `.env.example` ships
`SKILLS_SH_API_KEY=` with a comment marking it optional. The tool never shells out to
`vercel`; it only documents that path.

## Non-goals

- **Replacing the `npx skills` install flow.** skillwarden never installs, updates, or
  removes skills; `check` tells you _when_ to go run `npx skills` commands.
- Publishing, authoring, or scaffolding skills.
- Scraping GitHub or any non-API source at runtime.
- A TUI/daemon; skillwarden is single-shot and cron/CI-friendly.
- Historical trend storage (S-01 reads current views only; a time-series store is beyond
  even stretch).
- Verifying the registry's `hash` algorithm or recomputing it locally (D-07).

## Dependencies

Runtime: **none** (Node ≥ 20.10 stdlib: `fetch`, `util.parseArgs`, `node:crypto`,
`node:fs`, `node:path`, `node:os`, `node:readline`).

Dev (exact-pinned, lockfile committed): `typescript` 5.9.3 (compiler), `@types/node`
24.x (Node typings), `eslint` 9.x + `typescript-eslint` 8.x (lint), `prettier` 3.x
(format), `@eslint/js` (base config). Tests use built-in `node:test` — no framework dep.
Each dev dep justified by being the standard tool for its single job; nothing else.

## Phase 5 amendment (D-10)

Live verification showed the API's auth wall is per-route: the audit endpoint is
anonymously readable while listing/search/curated/detail return 401. Amendments to the
behavior specified above, logged as D-10:

- `check` without a token no longer skips network work; it attempts every fetch and
  reports only auth-walled planes as `unknown` (one stderr notice). The registry plane is
  currently the only walled one, so anonymous users still get live audit gating.
- The "401, no key" row of the error table applies to commands that cannot proceed at all
  without the gated route (`pin`); within `check` the same condition becomes per-plane
  degradation instead of an abort. A 401 **with** a key set aborts everywhere (exit 4).
- `riskLevel` is an open string set (live: `SAFE`), not strictly NONE→CRITICAL.
