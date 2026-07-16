# MISSION

You are running fully autonomously. Design, build, and verify a production-quality CLI tool that builds on the skills.sh Agent Skills Directory API. Work through Phases 0–5 in order. Do not ask for input except on a HARD BLOCKER (defined in Global Rules). Every other decision: make it, log it, proceed.

---

# GROUND TRUTH — SKILLS.SH API v1 (verified 2026-07-15; re-verify in Phase 0)

- Docs: https://skills.sh/docs/api · CLI docs: https://skills.sh/docs/cli · Source: https://github.com/vercel-labs/skills (Vercel-operated)
- Base URL: `https://skills.sh/api/v1` — all endpoints GET, JSON, HTTPS
- **Auth is optional.** Unauthenticated: 60 req/min per IP. Authenticated (`Authorization: Bearer sk_live_...`): 600 req/min. Keys are issued on request, not self-serve — **design anonymous-first**; a key is an enhancement, never a requirement.
- Rate-limit headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds). 429 includes `Retry-After`.
- Error envelope: `{"error": "code", "message": "..."}`. Statuses: 400 bad params, 401 bad key, 404 skill not found, 429 rate limited (wait `Retry-After`), 503 temporary (retry with backoff).

**Endpoints:**

1. `GET /skills` — leaderboard. Params: `view` = `all-time` (default) | `trending` | `hot`; `page` (0-indexed); `per_page` 1–500 (default 100). `hot` view adds `installsYesterday` and `change` (this hour vs same hour yesterday).
2. `GET /skills/search` — `q` (min 2 chars, required), `limit` 1–200 (default 50). Single-word = fuzzy, multi-word = semantic; response includes `searchType` and `durationMs`.
3. `GET /skills/curated` — official first-party set grouped by owner, with `totalOwners`, `totalSkills`, `generatedAt`.
4. `GET /skills/{source}/{slug}` — skill detail: `installs`, `hash` (SHA-256 of contents, null if no snapshot), `files[]` (**complete SKILL.md and supporting file contents**, null if no snapshot).
5. `GET /skills/audit/{source}/{slug}` — security audits from Gen Agent Trust Hub, Socket, Snyk, Runlayer, ZeroLeaks. Each: `status` = `pass` | `warn` | `fail`, `summary`, `auditedAt`, `riskLevel` = NONE→CRITICAL, `categories` (Trust Hub only). **404 means "not yet audited" — a data state, not a failure.** Audits generate automatically minutes after a skill's first install.

**Skill object (listing/search):** `id` = `{source}/{slug}` (stable), `name`, `source` (`owner/repo` or `domain.com`), `installs` (deduplicated), `sourceType` = `github` | `well-known`, `installUrl` (usable as `npx skills add {installUrl}`), `url`, `isDuplicate` (present+true when a detected fork/copy).

**Caching:** responses carry `Cache-Control` — leaderboard/search 30–60s, detail 5 min, curated 5 min. Respect these when polling.

**Existing first-party tooling:** `npx skills` (find + add/install) already exists and is good. Reimplementing it has zero value.

Design implications (binding):

1. **Search and install are already served** by the official CLI. Differentiation lives one layer up: audit-gated install policies, local install-base reconciliation and auditing, hash-based update/drift watching, trend intelligence from `hot`/`trending` deltas, duplicate filtering, curated-vs-community analysis.
2. `hash` + `files[]` enable a local mirror, content diffing, and offline analysis with zero GitHub scraping.
3. Client must honor `Cache-Control`, sleep on `Retry-After`/`X-RateLimit-Reset` for 429, retry with backoff on 503 only, and surface remaining quota from headers.
4. Audit results are tri-state-plus: pass / warn / fail / unaudited(404) — model all four.

---

# GLOBAL RULES

- **Files are the source of truth.** Persist every phase deliverable to the exact paths specified. At the start of each phase, re-read the prior phase's files from disk; do not rely on conversation memory.
- **Decision log.** Every non-obvious choice (language, libraries, storage format, UX tradeoffs, anything where a reasonable engineer could pick differently) gets an entry in `docs/DECISIONS.md`: `D-## | decision | alternatives considered | rationale`.
- **Git protocol.** `git init` at start. Conventional Commits (`feat:`, `docs:`, `test:`, `chore:`). Commit at every phase gate and at every completed build task.
- **API call budget:** ≤ 30 live calls total across the entire run, unauthenticated. Record every distinct response shape as a fixture under `tests/fixtures/` the first time; reuse fixtures thereafter.
- **Hard blockers — the only reasons to stop and ask:**
  1. Docs and API both unreachable after 3 attempts.
  2. The site's Terms of Service prohibit this use.
     Everything else is not a blocker: build against the documented contract plus captured fixtures, and record the assumption. There is no API key and none is needed.
- **No placeholders.** No TODOs, no stubs, no "implement later", no "add error handling as appropriate." If session budget threatens completeness, cut scope at the Phase 3 gate (demote features to stretch) — never cut quality mid-build.
- **Secrets:** if an optional API key is supported, it comes from the `SKILLS_SH_API_KEY` env var only. Never hardcoded, never written to any file, never echoed in logs. The tool must be fully functional without it.

---

## PHASE 0 — VERIFY & FIXTURE CAPTURE

1. Fetch https://skills.sh/docs/api and https://skills.sh/docs/cli. Diff against the Ground Truth block above; the live docs win.
2. Make live calls (within budget) to capture real fixtures: leaderboard in all three views (confirm `hot` extra fields), a fuzzy search and a semantic search, curated, one skill detail **with a populated `files[]` and `hash`**, one audit response with results, and one audit 404 (pick an obscure skill). Save raw JSON to `tests/fixtures/`.
3. Deliverable `docs/API_SURFACE.md`: endpoint table with observed (not just documented) behavior — pagination, cache headers seen, rate-limit headers seen, audit-partner coverage rates in your samples — plus an "Open questions" list with a working assumption for each.

**Gate:** all fixture types captured or blocker declared. Commit `docs: api surface verification and fixtures`.

---

## PHASE 1 — BRAINSTORM & SELECT

Generate **5 distinct tool ideas**, each:

- Genuinely useful daily to a developer running Claude Code (or any skills-consuming agent)
- **Not** a reimplementation of `npx skills find/add` — each idea must exploit at least two of: install telemetry (`trending`/`hot` deltas), security audits, `files[]`+`hash` content access, curated set, local install-base reconciliation, duplicate detection
- Realistic to build and drive from a terminal
- Tagged S/M/L, with a mix across the five

For each idea: 2–3 sentences of value proposition, key interactions, and which endpoints/fields it exercises.

**Score every idea 0–5 on:** daily utility · leverage of the data axes above · feasibility within this session · differentiation from the official CLI. Winner = highest total; tie-break = feasibility. **Hard constraint: the winner's MVP must be fully buildable and verifiable this session** — ambition lives in stretch goals.

Choose the implementation language/runtime here (it feeds the feasibility score). Bias toward first-class developer install ergonomics (single-command install: `npx` / `uvx` / `pipx` / single binary). Log as `D-01`.

Deliverable `docs/IDEAS.md`: all 5 ideas, score matrix, selection rationale. **Gate:** committed.

---

## PHASE 2 — SPEC

Write the PRD at `docs/PRD.md`:

- Problem statement and target user
- Feature list: MVP requirements as `R-01…R-nn`, stretch as `S-01…S-nn` — strictly separated
- CLI interface: every command, every flag, example invocations, exit codes
- Data model: exact storage location (respect platform conventions, e.g. XDG on Linux), format, and schema — including the response cache keyed by `hash`/`Cache-Control` and its invalidation rule, and any local install-base state
- Error handling: for each error class (400, 401 with key, 404 skill, 404 audit-as-unaudited, 429, 503, network failure, malformed response, cache-only offline mode), the exact user-facing message and exit code
- API client behavior: timeout values, client-side throttle to stay under 60/min, honor `Cache-Control`, sleep on `Retry-After` for 429, exponential backoff on 503 only, surface `X-RateLimit-Remaining`
- Auth: optional `SKILLS_SH_API_KEY` env var; every feature works without it
- Non-goals: explicit list — must include "replacing `npx skills` install flow" unless the chosen idea justifies otherwise in `DECISIONS.md`
- Dependencies: each one named, justified, and pinned. Minimal-deps bias — stdlib first.

**Gate:** every MVP feature maps to at least one `R-##`; every error class above appears in error handling. Commit.

---

## PHASE 3 — PLAN

Write `docs/PLAN.md`. No code in this phase.

- Numbered tasks, each: complexity (S/M/L), the `R-##` IDs it satisfies, explicit dependencies on prior tasks
- Task boundary rule: one concern per task, and each task ends in an independently testable deliverable
- Per task, an **Interfaces** block: what it consumes from earlier tasks and what it produces for later ones (exact function/command names and types)
- Complete file/folder tree for the repo
- Edge cases per component, enumerated concretely (not "handle edge cases") — include: `hash: null` and `files: null` details, `isDuplicate` handling, empty search results, `per_page` bounds, audit partner arrays with mixed statuses
- Test plan: which components get unit tests, plus the one fixture-backed end-to-end smoke path
- **Scope gate:** sum the estimates. If the total exceeds what you can finish at full quality this session, demote the lowest-scoring `R-##`s to stretch now and log the demotion in `DECISIONS.md`.
- **Self-review before committing:** (1) every `R-##` maps to a task; (2) zero placeholder language anywhere in the plan; (3) names/signatures consistent across tasks.

**Gate:** self-review passed. Commit.

---

## PHASE 4 — BUILD

Implement the plan in order. Requirements:

- All MVP `R-##`s complete; every file written in full
- Unit tests for core logic (API client, throttle/cache, audit-state modeling, local state); one integration smoke test that runs entirely from `tests/fixtures/` — **the suite must pass with no network and no API key**
- Linter and formatter configured and passing
- Pinned dependencies with a committed lockfile
- `README.md`: setup, usage with real copy-pasteable examples, config reference, exit codes
- `.env.example` with `SKILLS_SH_API_KEY=` and a comment noting it is optional
- Conventional commit per completed task

**Gate:** all MVP `R-##`s implemented, tests green, lint clean. Commit.

---

## PHASE 5 — VERIFY & SHIP

1. Run `--help` for the root command and every subcommand; capture the output.
2. Execute each MVP command's happy path — live API within remaining call budget, otherwise fixture-backed — and at least 3 error paths (rate-limit 429 handling, unaudited-skill 404, invalid input). Confirm messages and exit codes match the PRD exactly; fix any drift.
3. Follow `README.md` top-to-bottom literally in a clean shell. Fix any step that doesn't work as written.
4. Write `docs/SHIP_REPORT.md` and print it to chat:
   - `R-## → status` table (done / demoted-to-stretch, with the D-## reference for any demotion)
   - How to run it, in 3 commands
   - Remaining stretch goals (`S-##`)
   - Known limitations and every assumption carried forward from Phase 0's open questions

**Gate:** report written and committed. Done.
