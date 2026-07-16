# HANDOFF — context bridge for the next session

You are picking up `skillwarden` with zero conversation memory. This file plus the other
documents in `docs/` are the complete context. Read this first, then the pointer table at
the bottom.

## Current state (as of 2026-07-16)

- **What it is:** `npm audit` for agent skills — `scan` / `pin` / `check` / `audit`
  commands over the skills.sh Agent Skills Directory API, with a committable lockfile
  (`skillwarden.lock.json`), a Cache-Control-honoring disk cache, and `--fail-on` policy
  gating for CI.
- **All MVP requirements R-01…R-10 are done** (see `docs/SHIP_REPORT.md` for the table).
- **113 tests green** (112 unit + 1 end-to-end smoke that spawns the built binary against
  a loopback fixture server). The whole suite runs with **no network and no token**.
- **Zero runtime dependencies**; dev deps exact-pinned with committed `package-lock.json`.
- Packed size ≈ 23.5 kB / 21 files (`dist`, `README.md`, `LICENSE` only).
- **Not yet published to npm.** The name `skillwarden` was verified free on 2026-07-15.
  No git remote, no tags, no CI yet.
- Toolchain: TypeScript 5.9 strict (`erasableSyntaxOnly`; tests run `.ts` directly via
  Node type stripping, `rewriteRelativeImportExtensions` for emit), eslint flat config,
  prettier. Scripts: `npm test`, `npm run lint`, `npm run format:check`.

## Hard invariants — do not break these

1. **Zero runtime dependencies.** Node stdlib only. Adding a runtime dep defeats the
   tool's supply-chain story (D-01).
2. **The full test suite passes with no network and no API token.** Tests use fixtures,
   fake fetch/clock, and a loopback server exclusively.
3. **Error messages and exit codes are exact contracts.** The tables in `docs/PRD.md`
   (Error handling + Exit codes, as amended for D-10) are normative; tests assert on
   them, and so may users' scripts.
4. **D-07:** never recompute the registry's `hash` locally — its input is undocumented.
   Tamper = local files vs pinned digests; drift = pinned `hash` vs current registry
   `hash`.
5. **D-09:** `isDuplicate` is learned opportunistically from cached listing/search
   bodies; never spend a dedicated API call on it.
6. **D-10:** auth degradation is per-plane, not per-command. `check` always attempts its
   fetches; a 401 without a token degrades that plane to `unknown` (one notice), a 401
   with a token aborts (exit 4).
7. **CRLF→LF (and BOM) normalization in `src/core/discovery.ts` is load-bearing.** It is
   what keeps tamper detection from false-positing on Windows checkouts with git
   `autocrlf`. Any digesting of file content must go through the same normalization.

## Verified vs assumed (condensed from SHIP_REPORT / API_SURFACE)

> **⚠️ The authenticated path has NEVER run against the live API.** `pin` and the
> registry-drift plane of `check` have only ever executed against reconstructed
> fixtures (documented schema × real site-payload values). No Vercel OIDC token was
> available during the build. This is the single biggest unverified surface.

Verified live (2026-07-15, unauthenticated, ~14 of a 30-call budget used):

- Listing/search/curated/detail routes return **401** without a token; the **audit route
  is anonymously readable** (raw captures in `tests/fixtures/real-*.json`).
- Error envelope codes `authentication_required` (401) and `not_found` (audit 404) —
  the 404 message text is captured verbatim.
- `riskLevel` exceeds the documented NONE→CRITICAL enum (live value: `SAFE`); partner
  slug `agent-trust-hub`; UPPER_SNAKE `categories`; audit responses carry
  `Cache-Control: public` with **no max-age** and **no X-RateLimit headers**.
- End-user flows: `scan` on a real machine, live anonymous `audit`, tokenless `pin`
  exit-4 guidance, tarball install (`npm i ./skillwarden-0.1.0.tgz`).

Assumed (unverified):

- Success-response shapes for leaderboard/search/curated/detail (reconstructed
  fixtures; `pagination`, `searchType`, `files[]`/`hash` semantics).
- Any valid Vercel OIDC token authenticates; 600 req/min documented limit;
  `X-RateLimit-*` headers appear on authenticated responses.
- Error code strings for 400/429/503 (behavior keys off HTTP status only, per D-04, so
  low risk).

## Next-phase queue, in order

1. **GitHub Actions CI.** Matrix: ubuntu / windows / macos × Node 20 / 22 / 24. Steps:
   `npm ci`, `npm run lint`, `npm run format:check`, `npm test`. Zero secrets required —
   the suite is fixture-only by design. Note: `npm test` runs tests as `.ts` via Node
   type stripping, which needs Node ≥ 22.6 with flag / ≥ 23.6 unflagged — for the Node 20
   leg, run the compiled-output path or gate the unit-test step (the _shipped_ code
   supports ≥ 20.10; only the dev loop needs newer).
2. **Live authenticated verification** with a human-supplied `SKILLS_SH_API_KEY`.
   Budget ≤ 10 live calls: one leaderboard page, one search, curated, one detail with
   `files[]`+`hash` (diff against the reconstructed fixture and fix validators if the
   real shape differs), one `pin` + `check` round-trip, confirm `X-RateLimit-*` headers.
   Record results in `docs/API_SURFACE.md` as a dated addendum and update fixtures
   provenance notes. Never echo or commit the token.
3. **Publish `v0.1.0` to npm with provenance, from CI** (`npm publish --provenance`,
   OIDC trusted publishing or an `NPM_TOKEN` secret; tag `v0.1.0` first).
4. **Stretch features, in order:** S-02 `diff <id>` (pinned vs current registry
   `files[]` — needs auth), S-05 `cache info|clear`, S-04 `scan --identify`.
   Definitions in `docs/PRD.md` § Stretch.

## Which doc answers what

| Question                                                           | Document                                       |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| What does the API actually do / what was observed live?            | `docs/API_SURFACE.md` (incl. Phase 5 addendum) |
| What must each command do; exact messages and exit codes?          | `docs/PRD.md` (incl. D-10 amendment)           |
| How is the code structured; module interfaces; edge-case register? | `docs/PLAN.md`                                 |
| Why is anything the way it is?                                     | `docs/DECISIONS.md` (D-01…D-10)                |
| What shipped, what's verified, what's assumed?                     | `docs/SHIP_REPORT.md`                          |
| Where do fixtures come from; which are real captures?              | `tests/fixtures/README.md`                     |

## Conventions

- Decision log continues at **D-11** in `docs/DECISIONS.md` — same table format, one row
  per non-obvious choice.
- Conventional Commits (`feat:` / `docs:` / `test:` / `chore:`), one commit per logical
  change.
- `docs/SKILLS_SH_CLI_BUILD_PROMPT.md` is the original build brief — historical context
  only; where it contradicts `API_SURFACE.md`, the latter (live-verified) wins.
