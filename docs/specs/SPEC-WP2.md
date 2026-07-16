# SPEC-WP2 — Live authenticated verification (human-gated, ≤10 calls)

## Problem

The authenticated path — `pin`, and the registry-drift plane of `check` — has never
executed against the live API. Its fixtures are documented-schema reconstructions
(`skill-detail.json`, the listing `pagination` envelope), and SHIP_REPORT assumption #2
("any valid Vercel OIDC token authenticates") is unverified. If the real shapes diverge,
the lockfile and drift plane are built on sand. One human-gated session with a real
token settles it.

## Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-16 | A one-shot verification protocol, executed exactly as scripted below, that (a) confirms or refutes assumption #2, (b) diffs the real detail-endpoint shape against the reconstructed fixture (`files[]`, `hash` semantics), (c) optionally confirms the listing `pagination` envelope with one `GET /skills` page, and (d) runs a real `pin` + `check --refresh` end-to-end including the drift plane — within a hard budget of **≤ 10 live calls**, recording method, per-call ledger, and results in `docs/VERIFICATION.md`. The token is never echoed, logged, committed, or written to any file; captured headers are scrubbed of `Authorization` before saving. Any observed divergence from fixtures becomes a **planned corrective task** (new fixtures with provenance notes + parser/test updates), never an ad-hoc patch during the protocol. |

## Protocol

Preconditions (no live calls):

1. I ask you for the token; you first run `vercel env pull` to get a **fresh** value
   (OIDC tokens rotate ~12h; a stale `.env.local` 401s and wastes budget), then set
   `SKILLS_SH_API_KEY` in the session environment.
2. Temp working directory outside the repo with one real installed skill discoverable
   (reuse the machine's real `~/.claude/skills` roots — `scan` is offline and free).
3. Target skill: `vercel-labs/skills/find-skills` (the reconstruction embeds its real
   SKILL.md and SHA-256, giving maximum diff signal).

Call ledger (worst case 8 of 10; two reserved for a single token-refresh retry):

| #   | Call                                                                                                                              | Purpose                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `curl` `GET /skills/vercel-labs/skills/find-skills` (headers + body to scratchpad, Authorization scrubbed)                        | Assumption #2 (200 vs 401); raw capture of real detail shape; `X-RateLimit-*` presence on an authenticated response |
| 2   | `curl` `GET /skills?view=all-time&per_page=5`                                                                                     | Listing `pagination` envelope + `isDuplicate` presence (only spent if call 1 succeeded)                             |
| 3–4 | `skillwarden pin vercel-labs/skills/find-skills` (CLI's own detail + audit fetches; its cache is cold)                            | Real `pin` end-to-end; lockfile written with real `hash`/`files[]` digests                                          |
| 5–6 | `skillwarden check --refresh` (detail + audit refetch)                                                                            | Drift plane against live data; clean report expected                                                                |
| 7–8 | Reserve: one retry of calls 1 or 3–4 after a fresh `vercel env pull` if a 401 suggests token staleness rather than scheme failure | Distinguishes "stale token" from "assumption #2 refuted"                                                            |

Analysis (no live calls): structural diff of the captured detail body vs
`tests/fixtures/skill-detail.json` — field-by-field: envelope keys, `files[]` element
shape (`path`/`contents`), `hash` presence/format; digests of captured `files[].contents`
recomputed through `digestContent` to confirm the lockfile pipeline against real bytes;
`pagination` keys vs the reconstruction. Verify the written lockfile validates and
`check` reports `integrity: ok`, `registry: current`.

Outcomes:

- **All confirmed** → `docs/VERIFICATION.md` records the ledger + findings; fixture
  provenance notes in `tests/fixtures/README.md` gain a "confirmed live 2026-07-16"
  line; raw captures (scrubbed) land as `real-*.json` fixtures with provenance.
- **Divergence** → VERIFICATION.md records exactly what differs; corrective tasks
  (fixture replacement, parser change, test updates) are written into the WP-2 plan and
  executed under the normal gate (full suite offline, one commit each) **before** the
  release gate.
- **Assumption #2 refuted** (fresh token still 401s) → stop; report to you. The release
  proceeds only if you accept documenting the auth story as-is (audit-only anonymous
  tier verified; authenticated tier unverifiable).

## Error contract additions

None — no CLI surface changes. (The protocol _exercises_ existing contracts.)

## Test expectations

- The offline suite is untouched by the protocol itself; it stays green at every commit.
- If divergence forces fixture/parser changes, each corrective commit keeps the full
  offline gate green, and updated fixtures carry provenance notes.

## Non-goals

- No exploratory calls beyond the ledger (no leaderboard sweeps, no curated, no search
  beyond what call 2 provides).
- No fixture edits, parser changes, or "quick fixes" mid-protocol.
- No verification of the registry `hash` algorithm itself (D-07 stands).
- No storing of the token anywhere, including shell history (`SKILLS_SH_API_KEY` is set
  by you in the session environment, not typed into commands I run).
