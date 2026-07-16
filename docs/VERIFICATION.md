# Live verification — authenticated path (2026-07-16, WP-2)

The authenticated surface (`pin`, `check`'s registry-drift plane, gated routes) ran
against the live API for the first time, under SPEC-WP2's protocol. Token: a fresh
Vercel OIDC token supplied by the operator at the session gate (pulled via
`vercel env pull` minutes before use; read per-command from Vercel's `.env.local`
artifact, never echoed, logged, committed, or written by the tool).

## Call ledger

Budget ≤ 10. **Planned 6 / used 6 / reserve 2 / reserve used 0 — total 6 of 10.**

| #   | Call                                                                                | Status     | Purpose / result                                                                            |
| --- | ----------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| 1   | `curl GET /skills/vercel-labs/skills/find-skills` (Bearer)                          | 200        | Assumption #2 test + raw detail capture → `tests/fixtures/real-skill-detail-200.json`       |
| 2   | `curl GET /skills?view=all-time&per_page=5` (Bearer)                                | 200        | Pagination envelope capture → `tests/fixtures/real-listing-page.json`                       |
| 3–4 | `skillwarden pin vercel-labs/skills/find-skills` (cold cache; detail + audit fetch) | ok, exit 0 | Real pin end-to-end; lockfile written (`snapshot: registry`, real `hash`, 5 audit partners) |
| 5–6 | `skillwarden check --refresh` (detail + audit refetch)                              | ok, exit 0 | `integrity: ok`, `registry: current`, `audits: warn`; policy OK under `tamper,audit-fail`   |
| 7–8 | reserve (single token-refresh retry)                                                | —          | not needed                                                                                  |

Environment: temp project outside the repo; local `find-skills` seeded from the
fixture capture, then synced to the live contents after call 1 so calls 5–6 exercised
the clean path (tamper detection is already proven by the offline smoke suite).

## Findings

1. **Assumption #2 — CONFIRMED.** A plain Vercel OIDC token (no skills.sh-specific
   registration) authenticates the gated routes: calls 1 and 2 returned 200.
2. **Detail-endpoint shape — reconstruction structurally exact.** Live top-level keys
   (`files`, `hash`, `id`, `installs`, `slug`, `source`) and `files[]` element keys
   (`path`, `contents`) match `tests/fixtures/skill-detail.json` exactly. No extra or
   missing fields. No parser or fixture-shape corrections required.
3. **Fixture content mismatch = upstream drift, NOT reconstruction error.** The live
   SKILL.md differs from the 2026-07-15 capture by exactly one added line
   (`- npx skills check - Check for skill updates`, line 29) — genuine upstream
   evolution since capture. The fixture's content was a faithful capture.
4. **The registry `hash` is NOT sha256(file contents) — D-07 validated.**
   `sha256(live SKILL.md contents)` = `deddc03b…` (raw == normalized; equals the
   lockfile's per-file digest, proving the pin digest pipeline against real bytes),
   while the live `hash` field is `781bd6d3…`. The reconstruction's synthetic
   `hash = sha256(contents)` guess does not match the real algorithm. Nothing in the
   code ever relied on it (D-07: hash is opaque, compared only registry-to-registry) —
   `check` correctly reported `registry: current` live. The `hash` value inside
   `skill-detail.json` remains synthetic; the real value is in
   `real-skill-detail-200.json`.
5. **Pagination envelope — CONFIRMED.** `{ data, pagination: { page, perPage, total,
hasMore } }`, zero-based `page`, exactly as reconstructed (live: `total: 9591`).
   Listing entries omit `isDuplicate` (absent = unknown, per D-09 rendering).
6. **`X-RateLimit-*` headers are absent on authenticated 200s** (both captures) —
   extending the Phase 5 observation (absent on 401 and anonymous audit responses).
   As of 2026-07-16 they have not been observed on any response. The client tolerates
   absence by design; `--verbose` simply prints nothing.
7. **Authenticated routes send `Cache-Control: private, no-store`** (detail and
   listing; the anonymous audit route sent `public` with no max-age on 2026-07-15).
   The client stores 200s with the 60 s fallback TTL regardless — a deliberate,
   documented deviation (D-15): the disk cache is user-owned local state that powers
   `--offline` and stale-fallback (core features), and cached bodies contain public
   skill metadata, never credential material.

## Corrective tasks

**None required.** Every shape the code consumes matched live reality; the two value
divergences (upstream SKILL.md edit, synthetic fixture hash) are data-level and
documented above. New raw captures added with provenance:
`real-skill-detail-200.{json,headers.txt}`, `real-listing-page.{json,headers.txt}`
(response headers only — request headers, and thus the token, never appear in
captures).

## Verdict

SPEC-WP2 outcome 1 — **all confirmed**. The authenticated path is live-verified
end-to-end; the release can proceed on this surface.
