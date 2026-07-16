# Phase 1 — five tool ideas, scored

Context that shaped these: the API requires a token for all network calls (see
`API_SURFACE.md`), so ideas whose core loop works from local disk + cache score higher on
feasibility; network enrichment layers on top. Every idea exploits ≥2 of the six data axes
(install telemetry, security audits, `files[]`+`hash` content, curated set, local
install-base reconciliation, duplicate detection) and none reimplements `npx skills find/add`.

## Idea 1 — `skillwarden`: audit-gated install-base guard (M)

"`npm audit` for agent skills." Scans the machine's installed skills (Claude Code and
generic skill directories), pins each one's registry snapshot (`files[]`, `hash`, audits)
into a lockfile, then a single `check` command reports: local tampering (files differ from
pin), upstream drift (registry hash differs from pin), audit regressions (pass/warn/fail/
unaudited per partner), and installed forks (`isDuplicate`). `--fail-on` policy + exit
codes make it a CI/pre-commit gate. Scan and tamper detection work fully offline with no
token; registry enrichment uses detail + audit endpoints.
**Interactions:** `scan`, `pin`, `check [--fail-on warn|fail|drift|unaudited]`, `audit <id>`.
**Endpoints/fields:** `/skills/{source}/{slug}` (`hash`, `files[]`), `/skills/audit/...`
(all four audit states), `isDuplicate`, local install-base reconciliation.

## Idea 2 — `skillscope`: terminal trend intelligence (M)

Tracks the leaderboard over time: each run appends a local snapshot; reports movers,
velocity, new entrants, curated-vs-community share, with `hot`'s `installsYesterday`/
`change` for intraday spikes. Answers "what should I look at this week?" without opening
the site. Needs repeat runs over days before its core value shows — weak single-session
verifiability.
**Interactions:** `snapshot`, `movers [--window 7d]`, `newcomers`, `share`.
**Endpoints/fields:** `/skills?view=hot|trending|all-time` (telemetry), `/skills/curated`,
`isDuplicate` filtering.

## Idea 3 — `skillsnap`: content mirror + drift review (M)

Local mirror of selected skills via `files[]`+`hash`; `watch` polls (respecting
`Cache-Control`) and, on hash change, shows a unified diff of what actually changed in the
skill's instructions before you update — supply-chain review for prompt content. Overlaps
heavily with idea 1's pin/drift core but stops at diffing, without the audit/policy layer
that makes it actionable.
**Interactions:** `mirror add <id>`, `watch`, `diff <id>`.
**Endpoints/fields:** `files[]`, `hash`, audits shown at update time, local reconciliation.

## Idea 4 — `skillbrief`: daily digest (S/M)

One command prints a morning briefing: hot movers, audit status changes among *your*
installed skills, curated additions, duplicate alerts. High utility but it is an
aggregation of ideas 1+2 — building it first means building both of them shallowly.
**Interactions:** `brief [--json]`, cron-friendly.
**Endpoints/fields:** `hot` deltas, audits, curated, local install base.

## Idea 5 — `skillvet`: pre-install vetting report (S)

Point it at a skill id before installing: renders per-partner audit statuses and risk
levels, previews `SKILL.md`, flags content heuristics (fetch-and-exec patterns, base64
blobs), and identifies the canonical original when the skill is a fork. Useful, but
episodic (only at install time) rather than daily, and stateless — no local leverage.
**Interactions:** `vet <id>`, `vet --compare <id> <id>`.
**Endpoints/fields:** audits (incl. 404-as-unaudited), `files[]`, `isDuplicate`, `installs`.

## Score matrix (0–5 each)

| Idea | Daily utility | Data-axis leverage | Feasibility this session | Differentiation | Total |
|---|---|---|---|---|---|
| 1 skillwarden | 5 | 5 (4 axes) | 4 | 5 | **19** |
| 2 skillscope | 3 | 3 (2 axes) | 3 | 4 | 13 |
| 3 skillsnap | 4 | 4 (3 axes) | 4 | 5 | 17 |
| 4 skillbrief | 4 | 5 (4 axes) | 2 | 4 | 15 |
| 5 skillvet | 3 | 4 (3 axes) | 5 | 4 | 16 |

## Selection: idea 1 — `skillwarden`

Highest total, and the profile fits the constraints unusually well:

- **The auth wall favors it.** Its foundation (scan + tamper check against pins) is 100%
  offline and token-free, so the MVP is fully verifiable this session from fixtures; the
  token-holding user gets registry drift + audits on top. No other idea degrades this
  gracefully.
- **It subsumes the best of the others.** Idea 3's hash/diff core is its pin mechanism;
  idea 5's audit report is its `audit` command; ideas 2/4 remain clean stretch goals
  (`brief`) on the same client/cache.
- **Real daily driver.** Agents execute what skills tell them to; today nothing on a dev
  machine notices when an installed skill's instructions change upstream, a fork shadows
  the original, or an auditor flips to *fail*. Exit-code policy gating slots into CI the
  way `npm audit` does.

Key design insight from Phase 0 carried in: the registry's `hash` algorithm input is
undocumented, so drift detection never recomputes it locally — it compares local files
against *pinned* `files[]` (tamper) and pinned `hash` against *registry* `hash` (upstream
drift). Both comparisons use data the API hands us verbatim.

Language/runtime: Node.js ≥ 20 + TypeScript, zero runtime dependencies, `npx`-distributable
— logged as D-01 in `DECISIONS.md`.
