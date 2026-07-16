# skills.sh API v1 — verified surface (2026-07-15)

## Headline finding: the ground-truth brief is stale on auth

The build brief said "auth is optional; unauthenticated 60 req/min; keys are `sk_live_...`".
**Live reality: every `/api/v1/*` endpoint returns `401 authentication_required` without a
`Authorization: Bearer <VERCEL_OIDC_TOKEN>` header.** Verified 2026-07-15 against
`GET /skills` (all three views), `/skills/search`, `/skills/curated`, on both `skills.sh`
and `www.skills.sh` (7 live calls). The live docs corroborate: the only documented auth is
Vercel OIDC federation (`vercel link` + `vercel env pull`, token rotates ~12 h); there is no
`sk_live` key mechanism and no documented anonymous tier. The documented authenticated
limit is 600 req/min per (team, project).

Real 401 envelope (captured, `tests/fixtures/error-401.json`):

```json
{
  "error": "authentication_required",
  "message": "This endpoint requires authentication. Pass a Vercel OIDC token (Authorization: Bearer <VERCEL_OIDC_TOKEN>) — see https://skills.sh/docs/api#authentication."
}
```

Consequences for design (binding for Phases 1–5):

1. A live-API token is a **prerequisite for network features**, not an enhancement.
   The tool reads it from `SKILLS_SH_API_KEY` (accepts a Vercel OIDC token value).
2. Offline/cache-first behavior and features that work from local disk state alone
   are now first-class, not degraded modes.
3. ToS explicitly permits programmatic use and **encourages caching on your own
   infrastructure** ("Reasonable use, including caching results on your own
   infrastructure, is encouraged and not restricted"). Prohibited: rate-limit bypass,
   scraping that bypasses limits, service degradation.

## Endpoint table (documented; observed where possible)

| Endpoint                                   | Params                                                                                                                          | Documented response                                                                                                                                                        | Observed 2026-07-15                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/v1/skills`                       | `view` = `all-time` (default) \| `trending` \| `hot`; `page` 0-indexed; `per_page` 1–500 (default 100)                          | `{data: Skill[], pagination: {page, perPage, total, hasMore}}`; `hot` adds `installsYesterday`, `change` per skill                                                         | 401 without token; JSON error envelope confirmed |
| `GET /api/v1/skills/search`                | `q` required, min 2 chars; `limit` 1–200 (default 50); `owner` (GitHub owner filter — **not in the brief; live docs addition**) | `{data, query, searchType: "fuzzy"\|"semantic", count, durationMs}`; single word→fuzzy, multi-word→semantic                                                                | 401 without token                                |
| `GET /api/v1/skills/curated`               | —                                                                                                                               | `{data: [{owner, totalInstalls, featuredRepo, featuredSkill, skills[]}], totalOwners, totalSkills, generatedAt}`                                                           | 401 without token                                |
| `GET /api/v1/skills/{source}/{slug}`       | path: GitHub = 3 segments (`owner/repo/slug`), well-known = 2 (`domain.com/slug`)                                               | `{id, source, slug, installs, hash: sha256\|null, files: [{path, contents}]\|null}`                                                                                        | 401 without token                                |
| `GET /api/v1/skills/audit/{source}/{slug}` | same path rules                                                                                                                 | `{id, source, slug, audits: [{provider, slug, status: pass\|warn\|fail, summary, auditedAt, riskLevel?: NONE→CRITICAL, categories?}]}`; 404 = not yet audited (data state) | 401 without token                                |

Skill object (listings/search): `id` (= `{source}/{slug}`, stable), `slug`, `name`, `source`,
`installs` (deduplicated), `sourceType` = `github` \| `well-known`, `installUrl`, `url`,
`isDuplicate` (present+true only for detected forks/copies). The `slug` top-level field and
the `pagination` object are live-docs additions relative to the brief.

## Headers observed

On the 401 (only response obtainable unauthenticated):

- `Cache-Control: public, max-age=0, must-revalidate` — errors are not cached
- **No `X-RateLimit-*` headers on 401** — quota headers evidently appear only on
  authenticated responses; the client must tolerate their absence
- `Server: Vercel`, `X-Matched-Path: /api/v1/skills` — routing confirmed even when unauthenticated

Documented for success responses: `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (seconds); `Retry-After` on 429; `Cache-Control` 30–60 s on
leaderboard/search, 5 min on detail/curated.

Host behavior: HTML pages 308-redirect `skills.sh` → `www.skills.sh`; the API answers
identically on both hosts (no redirect). Client should follow redirects anyway.

## Real data captured despite the auth wall

- 600 real leaderboard entries (site-rendered payload): source, skillId, name, installs,
  8-week install series, isOfficial → `tests/fixtures/site-leaderboard-raw.json`
- Real `SKILL.md` of `vercel-labs/skills/find-skills` (GitHub) → embedded in
  `tests/fixtures/skill-detail.json` with its true SHA-256
- Audit partner rendering on skill pages (Socket "Pass" observed for find-skills;
  per-partner routes `/{source}/{slug}/security/{partner}`)
- Wayback Machine has **no** archived `/api/v1/*` snapshots (checked 3 URLs)

Audit-partner coverage rates in samples: **not measurable** without auth. Working
assumption: popular skills have full 5-partner coverage; long-tail skills partial or none.

## Open questions → working assumptions

| #   | Question                                                           | Working assumption                                                                                                                                     |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Error `code` strings for 400/404/429/503                           | Envelope shape is documented; treat `error` as an opaque string, key all behavior off HTTP status. Assumed strings live in fixtures only.              |
| 2   | Do any Vercel-account OIDC tokens work, or only allowlisted ones?  | Any valid Vercel OIDC token authenticates (docs: "no signup, no key to generate"); scoping is for rate-limit accounting per (team, project).           |
| 3   | `installUrl` exact format per sourceType                           | GitHub → repo URL; well-known → `https://{domain}/.well-known/skills/{slug}`. Client never parses it — passes it through to `npx skills add` verbatim. |
| 4   | `trending`/`hot` ranking algorithms                                | Opaque server-side ranking; client displays returned order, never re-sorts. Fixture ranking approximated from real weekly series.                      |
| 5   | Do `X-RateLimit-*` headers appear on every authenticated response? | Yes per docs; client treats them as optional everywhere (confirmed absent on 401).                                                                     |
| 6   | `pagination.total` semantics (total skills vs total pages)         | Total item count across pages; `hasMore` is authoritative for iteration.                                                                               |
| 7   | Are multi-file skills' `files[]` ordered?                          | No order guarantee; treat as a set keyed by `path`; hash the set canonically when comparing.                                                           |
| 8   | 60 req/min anonymous tier                                          | Removed (or never shipped); design assumes 0 req/min unauthenticated, 600/min authenticated.                                                           |

## Phase 5 addendum (live verification, 2026-07-15, ~13 total live calls)

The auth wall is **per-route**, not global:

| Route | Unauthenticated result |
| --- | --- |
| `GET /skills` (all views), `/skills/search`, `/skills/curated` | 401 |
| `GET /skills/{source}/{slug}` (detail) | 401 (`real-skill-detail.json`) |
| `GET /skills/audit/{source}/{slug}` | **200 — anonymously readable** (`real-audit.json`) |

Additional observations from the real audit responses:

- Audit 404 envelope confirmed: `{"error":"not_found","message":"No security audits found for this skill. Audits are generated automatically after a skill is installed for the first time."}` — the assumed code string was correct.
- `riskLevel` values exceed the documented NONE→CRITICAL scale: Gen Agent Trust Hub returns `SAFE`. Treat the field as an open string set.
- Trust Hub's partner `slug` is `agent-trust-hub`; `categories` are UPPER_SNAKE (`COMMAND_EXECUTION`, `EXTERNAL_DOWNLOADS`).
- Audit responses carry `Cache-Control: public` with **no max-age** (client falls back to its 60 s default) and **no `X-RateLimit-*` headers**.
- A modestly popular long-tail skill (24 k installs) had full 5-partner coverage — audit coverage is deeper than assumed.
