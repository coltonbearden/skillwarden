# skillwarden — ship report (2026-07-15)

`npm audit` for agent skills: pin, verify, and audit-gate the skills your coding agents
execute. Built on the skills.sh Agent Skills Directory API. Node ≥ 20.10, TypeScript,
**zero runtime dependencies**, 23.5 kB packed.

## Requirement status

| ID   | Requirement                                              | Status |
| ---- | -------------------------------------------------------- | ------ |
| R-01 | CLI skeleton, global flags, per-command help, exit codes | done   |
| R-02 | Local discovery + fingerprinting (`scan`)                | done   |
| R-03 | API client: throttle, retries, error mapping             | done   |
| R-04 | Disk response cache honoring Cache-Control               | done   |
| R-05 | Versioned deterministic lockfile                         | done   |
| R-06 | `pin` with registry snapshots                            | done   |
| R-07 | `check` with three planes + `--fail-on` policy           | done   |
| R-08 | `audit` with four-state modeling                         | done   |
| R-09 | Output layer: tables, color rules, stable `--json`       | done   |
| R-10 | Packaging, README, `.env.example`, pinned deps, lockfile | done   |

No demotions. 113 tests green (112 unit + 1 end-to-end smoke over the built binary
against a loopback fixture server — no network, no token). Lint and format clean.
Live API budget used: ~14 of 30 calls.

## Run it in 3 commands

```console
npx skillwarden scan                              # inventory installed skills (offline)
npx skillwarden audit vercel-labs/skills/find-skills   # live security report (works anonymously)
npx skillwarden check --fail-on tamper,audit-fail      # CI gate (after 'pin'; needs token for drift plane)
```

Until published to npm, substitute the packed tarball:
`npm i ./skillwarden-0.1.0.tgz && npx skillwarden …` — verified end-to-end in a clean
project this session (scan found this machine's real installed skills; `audit` returned
live data; tokenless `pin` produced the documented exit-4 guidance).

## Remaining stretch goals

- S-01 `brief`: morning digest from `hot`/`trending` deltas + lockfile audit changes
- S-02 `diff <id>`: content diff of pinned vs current registry `files[]`
- S-03 config file (roots, default policy, TTL override)
- S-04 `scan --identify`: suggest registry ids via search
- S-05 `cache info|clear` subcommand
- S-06 curated-set cross-reference

## Known limitations

- **Auth wall is per-route and undocumented.** Listing/search/curated/detail return 401
  without a Vercel OIDC token; the audit route is anonymously readable (verified live).
  So without a token: `scan`, integrity checking, live `audit`, and cached data all work;
  `pin` and `check`'s registry-drift plane need `SKILLS_SH_API_KEY`. This can change
  server-side at any time; `check` degrades per-plane rather than assuming either world.
- Success-path fixtures for the gated routes are documented-schema reconstructions
  populated with real site data (600 real leaderboard entries, the real find-skills
  SKILL.md and its true SHA-256); the audit-route and error-envelope fixtures are raw
  live captures.
- `isDuplicate` is only available on listing/search responses, so pins learn it
  opportunistically from cache (D-09); tokenless users effectively never see it.
- The registry `hash` algorithm is unverified; drift compares registry values across
  time, never a locally recomputed hash (D-07).

## Assumptions carried from Phase 0 (docs/API_SURFACE.md)

1. Error envelope codes treated as opaque; behavior keys off HTTP status only —
   **confirmed** for 401 (`authentication_required`) and 404 (`not_found`), live.
2. Any valid Vercel OIDC token authenticates (unverifiable without a Vercel account).
3. `installUrl` format never parsed, passed through verbatim.
4. `trending`/`hot` ranking is opaque; returned order preserved.
5. `X-RateLimit-*` headers optional everywhere — **confirmed**: absent on 401 and on
   anonymous audit responses.
6. `pagination.hasMore` authoritative for iteration.
7. `files[]` treated as an unordered set keyed by path.
8. Anonymous tier: originally assumed fully removed; **revised** by live evidence to
   per-route gating (D-10). `riskLevel` is an open string set (live: `SAFE`).

## Repo map

Docs: `docs/API_SURFACE.md` (verified API surface), `docs/IDEAS.md` (5 scored ideas),
`docs/PRD.md` (requirements + error contract), `docs/PLAN.md` (18 tasks),
`docs/DECISIONS.md` (D-01…D-10). Source: `src/` (CLI, API client/cache, discovery,
lockfile, audit model, check engine). Tests: `tests/unit/*`,
`tests/integration/smoke.test.ts`, and `tests/fixtures/` (provenance in its README).
