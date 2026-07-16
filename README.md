# skillwarden

`npm audit` for agent skills: pin, verify, and audit-gate the skills your coding agents execute.

Agent skills are instruction packages that tools like Claude Code run with your credentials
and filesystem. After `npx skills add`, nothing on your machine notices when an installed
skill's files change locally (tampering), when upstream content drifts, when a security
auditor flips it to _fail_, or when what you installed is a fork of the canonical skill.
skillwarden gives you the lock-verify-gate loop you already use for npm packages, built on
the [skills.sh](https://skills.sh) directory API.

- **Zero runtime dependencies.** Node ≥ 20.10 stdlib only.
- **Offline-first.** `scan` and integrity checking never touch the network; registry and
  audit data is cached and usable offline.
- **CI-ready.** `check --fail-on …` turns findings into exit codes.

## Install

```console
npx skillwarden --help
```

or permanently:

```console
npm install -g skillwarden
```

## Quickstart

```console
# 1. What skills are installed on this machine?
npx skillwarden scan

# 2. Pin one: snapshot its registry content digests, hash, and security audits
#    into ./skillwarden.lock.json (commit this file)
npx skillwarden pin vercel-labs/skills/find-skills

# 3. The daily driver — compare local files, upstream content, and audits
#    against the pin
npx skillwarden check

# 4. Gate CI on tampering and failed audits (the default policy), plus drift
npx skillwarden check --fail-on tamper,audit-fail,drift

# 5. Read the security report for any skill before installing it
npx skillwarden audit mattpocock/skills/grill-me
```

`check` reports three planes per pinned skill:

| Plane     | Compares                                 | States                                                                   |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| integrity | local files vs pinned digests            | `ok`, `modified`, `missing-file`, `extra-file`, `dir-missing`, `unknown` |
| registry  | pinned `hash` vs current registry `hash` | `current`, `update-available`, `gone`, `unknown`                         |
| audits    | current partner audits vs pin            | `pass`, `warn`, `fail`, `unaudited`, `unknown` (+ _regressed since pin_) |

## Authentication

The skills.sh API currently requires a bearer token — its docs describe Vercel OIDC tokens
(no signup or key generation; any Vercel project can mint one):

```console
vercel link          # once, in any project of yours
vercel env pull      # writes VERCEL_OIDC_TOKEN into .env.local (rotates ~12h)
```

Give the value to skillwarden via the `SKILLS_SH_API_KEY` environment variable:

```console
# PowerShell
$env:SKILLS_SH_API_KEY = (Select-String -Path .env.local -Pattern '^VERCEL_OIDC_TOKEN="?([^"]*)"?$').Matches.Groups[1].Value

# bash/zsh
export SKILLS_SH_API_KEY="$(grep -oP '^VERCEL_OIDC_TOKEN="?\K[^"]*' .env.local)"
```

**Everything except live registry/audit lookups works without a token:** `scan` is fully
offline, `check` still verifies local integrity (registry/audit planes report `unknown`),
and `check --offline` / `audit --offline` run from previously cached responses. The token
is never written to disk or logged.

## Commands

### `skillwarden scan [--root <path>]... [--json]`

Inventories local skills (directories directly containing `SKILL.md`) and fingerprints
their contents (SHA-256, CRLF-normalized). Default roots: `.claude/skills`,
`.agents/skills`, `skills` (+ `skills/.curated`, `.experimental`, `.system`) in the
project, plus `~/.claude/skills`, `~/.cursor/skills`, `~/.codex/skills`. Symlinked
duplicates (the official CLI symlinks by default) collapse into one entry. `--root`
replaces the defaults and must exist.

### `skillwarden pin <id>... | --all [--dir <path>] [--offline] [--refresh] [--json]`

Snapshots registry state for installed skills into `./skillwarden.lock.json`: per-file
content digests (from the registry's `files[]` when available, else the local files),
the registry content `hash`, install count, and per-partner audit statuses. Ids look like
`owner/repo/slug` (GitHub) or `domain.com/slug` (well-known). The local directory is
matched by slug; use `--dir` when ambiguous. `--all` re-pins everything in the lockfile.

### `skillwarden check [--fail-on <cond,...>] [--offline] [--refresh] [--json]`

Verifies every pinned skill on the three planes above and applies the policy:
conditions `tamper`, `drift`, `audit-fail`, `audit-warn`, `unaudited`, `duplicate`,
`gone`, or `none`; default `tamper,audit-fail`. Exit 1 when any matching finding exists.
Skills on disk but not pinned are listed informationally. A mid-run API failure aborts
the command (a half-checked report never reads as clean); per-skill registry 404s are
reported as `gone` findings instead.

### `skillwarden audit <id> [--offline] [--refresh] [--json]`

Per-partner security report (Gen Agent Trust Hub, Socket, Snyk, Runlayer, ZeroLeaks —
whichever have results) with status, risk level, date, summary, and categories, plus a
worst-of overall verdict. A skill with no audits yet is a normal data state (exit 0).

## Configuration reference

| Environment variable    | Purpose                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SKILLS_SH_API_KEY`     | Optional bearer token for the skills.sh API (see Authentication). Required only for live registry/audit data.                                                                                          |
| `SKILLWARDEN_CACHE_DIR` | Override the response cache location. Defaults: `%LOCALAPPDATA%\skillwarden\cache` (Windows), `~/Library/Caches/skillwarden` (macOS), `$XDG_CACHE_HOME/skillwarden` or `~/.cache/skillwarden` (Linux). |
| `SKILLWARDEN_API_BASE`  | Override the API base URL (testing). Default `https://skills.sh/api/v1`.                                                                                                                               |
| `NO_COLOR`              | Disable ANSI color (also: `--no-color`, or non-TTY output).                                                                                                                                            |

Files: `./skillwarden.lock.json` — the committable pin state (`lockfileVersion: 1`,
deterministic key order, forward-slash relative paths). The response cache honors the
API's `Cache-Control` headers (30–60 s listings, 5 min detail/curated) and only ever
stores status-200 bodies.

Client behavior: ≥1 s between requests (a tenth of the documented 600/min authenticated
limit), 10 s timeout, one waited retry on 429 (`Retry-After`, capped 60 s), three
backoff retries on 503 (1/2/4 s), stale-cache fallback with a warning when the network
is unreachable.

## Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | Success — including benign data states (clean check, unaudited skill)                        |
| 1    | `check` findings at/above `--fail-on`; or the requested skill does not exist                 |
| 2    | Usage error: unknown command/flag, malformed id, invalid `--fail-on`, API 400                |
| 3    | Unavailable: network failure, persistent 429/503, malformed response, `--offline` cache miss |
| 4    | Auth: token missing or rejected for an operation that needs the registry                     |

## CI recipe (GitHub Actions)

```yaml
- name: Verify agent skills
  run: npx skillwarden check --fail-on tamper,audit-fail,drift
  env:
    SKILLS_SH_API_KEY: ${{ secrets.SKILLS_SH_API_KEY }}
```

## Limitations

- The skills.sh API requires a token for all live reads (verified 2026-07-15); without
  one you keep local integrity checking and cached data only.
- Audit coverage varies by skill; a long-tail skill may legitimately be `unaudited`.
- The registry's `hash` input is undocumented, so skillwarden never recomputes it —
  drift is detected by comparing registry values across time, tampering by comparing
  local files against pinned digests.
- `isDuplicate` is only learnable from listing/search responses; skillwarden fills it
  opportunistically from cached data rather than spending extra API calls.

## Development

```console
npm install
npm test          # build + unit + fixture-server integration (no network, no token)
npm run lint
npm run format:check
```

MIT © Colton Bearden
