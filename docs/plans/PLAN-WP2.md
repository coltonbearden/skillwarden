# WP-2 — Live authenticated verification: execution plan

> **For agentic workers:** this WP is a human-gated _protocol_, not feature work. Tasks
> run inline (no subagents — the token stays in one process's environment). The hard
> budget is **≤ 10 live calls**; the ledger below is the only authorized call list.

**Goal:** confirm or refute the authenticated-path assumptions and record the evidence
in `docs/VERIFICATION.md` — per `docs/specs/SPEC-WP2.md` (R-16).

**Architecture:** raw `curl` captures for shape evidence (responses only — request
headers are never written anywhere), then the real CLI end-to-end in a temp project.
Analysis is fully offline. Divergence becomes planned corrective tasks, never mid-protocol
patches.

## Global constraints

- ≤ 10 live calls total, counted per the ledger; CLI-internal fetches count.
- The token is never echoed, logged, committed, or written to a file. Captured response
  headers are checked for echoes of credentials before saving (none expected — request
  headers are not in `curl -D` output).
- The offline suite stays green at every commit; no fixture/parser edits mid-protocol.

Execution order = task number order.

### W2-T1 — preflight (0 live calls) [S] — deps: none

Scratch area: `$SCRATCH = <session scratchpad>/wp2/`. Temp project outside the repo:
`$SCRATCH/proj/`. Confirm a real installed skill is discoverable (offline):

```bash
cd "$SCRATCH/proj" && node <repo>/dist/cli.js scan
```

Expect ≥ 1 skill from the machine's real `~/.claude/skills`. Pick the pin target:
`vercel-labs/skills/find-skills` **if `scan` lists `find-skills` locally**, else the
lowest-risk listed skill whose registry id is known; record the choice in the ledger.
Build fresh `dist/`: `npm run build` in the repo first.

**Verify:** scan output shows the target skill; no lockfile exists yet in `$SCRATCH/proj`.

### W2-T2 — token moment (0 live calls) [gate] — deps: W2-T1

Ask the user: run `vercel env pull` for a **fresh** token (OIDC rotates ~12h; stale
values 401 and burn budget), then set `SKILLS_SH_API_KEY` in the session environment.
Confirm presence without echoing:

```bash
[ -n "$SKILLS_SH_API_KEY" ] && echo "token present (${#SKILLS_SH_API_KEY} chars)"
```

**Verify:** "token present" printed; the value itself never appears in any output.

### W2-T3 — shape captures: calls 1–2 [M] — deps: W2-T2

Call 1 (detail — assumption #2 + real `files[]`/`hash` shape + rate-limit headers):

```bash
curl -sS -D "$SCRATCH/detail.headers.txt" -o "$SCRATCH/detail.json" \
  -H "Authorization: Bearer $SKILLS_SH_API_KEY" \
  -H "User-Agent: skillwarden-verify/0.1.0" \
  "https://skills.sh/api/v1/skills/vercel-labs/skills/find-skills"
head -c 400 "$SCRATCH/detail.json"; grep -i "x-ratelimit" "$SCRATCH/detail.headers.txt"
```

- **200** → assumption #2 confirmed; proceed to call 2.
- **401** → do NOT immediately retry. Report to the user, request one fresh
  `vercel env pull` (reserve call, ledger #7), retry once. Second 401 → assumption #2
  refuted → stop, write findings, report (SPEC-WP2 outcome 3).

Call 2 (listing pagination envelope — only after call 1 succeeded):

```bash
curl -sS -D "$SCRATCH/listing.headers.txt" -o "$SCRATCH/listing.json" \
  -H "Authorization: Bearer $SKILLS_SH_API_KEY" \
  -H "User-Agent: skillwarden-verify/0.1.0" \
  "https://skills.sh/api/v1/skills?view=all-time&per_page=5"
```

**Verify:** both bodies are valid JSON (`jq . >/dev/null`); headers files contain
response headers only.

### W2-T4 — CLI end-to-end: calls 3–6 [M] — deps: W2-T3

In `$SCRATCH/proj` (cold CLI cache via `SKILLWARDEN_CACHE_DIR=$SCRATCH/cache`):

```bash
node <repo>/dist/cli.js pin vercel-labs/skills/find-skills --verbose   # calls 3-4 (detail + audit)
node <repo>/dist/cli.js check --refresh --verbose                      # calls 5-6 (detail + audit)
```

Expected: pin exit 0, `pinned vercel-labs/skills/find-skills`; lockfile written with
real `registryHash` + `files` digests; check exit 0, `integrity: ok`,
`registry: current`, audit plane populated; `--verbose` shows `X-RateLimit-*` when the
API sends them. A 401 here after T3 succeeded → token rotated mid-protocol → one
refresh + one retry of the failed command (ledger #7–8 reserve), else stop.

**Verify:** `jq .skills "$SCRATCH/proj/skillwarden.lock.json"` shows the pinned entry;
exit codes 0.

### W2-T5 — offline analysis (0 live calls) [M] — deps: W2-T4

Field-by-field structural comparison, all local:

1. `detail.json` vs `tests/fixtures/skill-detail.json`: top-level keys; `files[]`
   element shape (`path`, `contents` — names and types); `hash` type/format;
   any fields the reconstruction invented or missed.
2. Recompute digests of the captured `files[].contents` through the real pipeline
   (`node --experimental-strip-types` one-liner importing `digestContent` from
   `src/core/discovery.ts`) and compare with the lockfile `files` map W2-T4 wrote —
   proves pin's digest path against real bytes.
3. `listing.json` vs `tests/fixtures/leaderboard-all-time.json`: `pagination` keys
   (`page`/`perPage`/`total`/`hasMore`), entry shape, `isDuplicate` presence.
4. Rate-limit reality: headers present/absent on 200s; values vs the documented 600/min.

**Verify:** a written divergence list — empty or itemized.

### W2-T6 — record + provenance [S] — deps: W2-T5

Write `docs/VERIFICATION.md`: date, token class (described, not shown), the executed
call ledger with URL/status/purpose per call, findings per assumption (#2, detail
shape, pagination, rate-limit headers), and the verdict per SPEC-WP2's three outcomes.
Add scrubbed captures as fixtures **only where they answer something a fixture doesn't
already** (`real-skill-detail-200.json` + headers, `real-listing-page.json` + headers),
with provenance rows in `tests/fixtures/README.md`. Update `docs/SHIP_REPORT.md`
assumption #2 status. Full gate; delete `$SCRATCH/wp2` residue (nothing sensitive is in
it, but leave nothing behind).

**Verify:** full gate green; `git grep -i "$(echo bearer)" docs/ tests/` shows no
credential material (visual check of new files).
**Commit:** `docs: live verification of the authenticated path (R-16)` — or, on
divergence, `docs: live verification found fixture divergences (R-16)`.

### W2-T7 — corrective tasks (conditional) [size = findings] — deps: W2-T6

Only if W2-T5 found divergence. For each: replace/add the fixture (provenance noted) →
run the affected unit suites (expect red if the parser disagrees with reality) → fix
the parser/validator minimally → full gate → one commit per divergence
(`fix: align <surface> with live API shape (R-16)`). These land **before** the release
gate (approved session amendment 1).

## Self-review

R-16(a)→W2-T3 call 1 (+ reserve logic); (b)→W2-T3/T5; (c)→W2-T3 call 2; (d)→W2-T4;
ledger + VERIFICATION.md→W2-T6; divergence-as-planned-work→W2-T7. Budget: 6 planned + 2
reserve = 8 ≤ 10. Token appears in no command output, no file, no commit.

## Non-goals

Exploratory calls; mid-protocol fixes; hash-algorithm verification (D-07); automating
the protocol as a test.
