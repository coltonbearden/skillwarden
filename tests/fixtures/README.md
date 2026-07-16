# Fixture provenance

Captured/generated 2026-07-15. The skills.sh API v1 returned `401 authentication_required`
to every unauthenticated request that day (verified on both `skills.sh` and `www.skills.sh`),
so raw captures of success responses were impossible without a Vercel OIDC token.
Fixtures fall into three provenance classes:

## Real captures (raw bytes from the live service)

| File | Source |
|---|---|
| `error-401.json` + `error-401.headers.txt` | `GET https://skills.sh/api/v1/skills?view=all-time&per_page=5`, unauthenticated, 2026-07-15 |
| `site-leaderboard-raw.json` | `initialSkills` array from the server-rendered `https://www.skills.sh/` payload, 2026-07-15 — 600 real entries with `source`, `skillId`, `name`, `installs`, `weeklyInstalls[8]`, `isOfficial` |

## Reconstructions (documented schema × real values)

Shapes follow https://skills.sh/docs/api as published 2026-07-15. Values (ids, names,
sources, install counts, official owners) come from `site-leaderboard-raw.json`;
`skill-detail.json` embeds the real `SKILL.md` of `vercel-labs/skills/find-skills`
(fetched from GitHub) and its actual SHA-256. Socket=pass for find-skills was observed
on the rendered site; other audit entries are plausible reconstructions.

- `leaderboard-all-time.json` — real ranking order
- `leaderboard-trending.json` — real entries; ranking approximated by last-week installs (true trending algorithm unknown)
- `leaderboard-hot.json` — real entries; `installsYesterday`/`change` derived from real weekly series (÷7)
- `search-fuzzy.json`, `search-semantic.json`, `search-empty.json` — real matching entries; `durationMs` invented
- `curated.json` — real official owners/skills grouped per documented shape; `generatedAt` is a fixed synthetic timestamp
- `skill-detail.json` — real content + real hash-of-content
- `skill-detail-nosnapshot.json` — documented `hash: null` / `files: null` state
- `audit-results.json` — all five documented partners, all pass
- `audit-mixed.json` — pass/warn/fail mix with partial partner coverage, for state modeling

## Assumed (error envelopes; only the 401 code is confirmed)

`error-400.json`, `error-404-skill.json`, `error-404-audit.json`, `error-429.json`,
`error-503.json` follow the documented `{"error": code, "message": text}` envelope with
assumed code strings. The one confirmed real code is `authentication_required` (401).
Parsers must treat `error` codes as opaque strings and key behavior off HTTP status only.
