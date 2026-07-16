# SPEC-WP4 — `cache info | clear` (S-05)

## Problem

The response cache is invisible: users can't see where it lives, how much disk it uses,
or how stale it is, and the only way to reset it is to find the platform-specific
directory by hand. A tool that tells users to trust its cached answers owes them
`info` and `clear`.

## Requirements

| ID   | Requirement                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-18 | `skillwarden cache info` reports location, entry count, corrupt count, total size, freshness breakdown, and `oldest`/`newest` per the semantics below — offline, exit 0 on missing/empty dir, with the documented deterministic `--json` shape.             |
| R-19 | `skillwarden cache clear` deletes only cache entry files (`^[0-9a-f]{64}\.json$` plus orphaned `*.json.tmp`), refuses without `--yes` via the exact contract row below (exit 2, live count/size), reports what it cleared, and never prompts interactively. |

## CLI surface

```
skillwarden cache <subcommand>

Subcommands:
  info      Show cache location, entry count, size, freshness (offline)
  clear     Delete all cached responses

Options: --json, --no-color, --verbose (existing semantics)
cache clear options:
  --yes     Confirm deletion (required; there is no interactive prompt)
```

`cache` never touches the network. Unknown subcommand or missing subcommand → existing
usage contract (usage message, exit 2). `--offline`/`--refresh` are not accepted
(unknown-flag usage error, exit 2) — there is nothing to fetch.

## Semantics

**`cache info`** — resolves the cache directory exactly as the client does
(`SKILLWARDEN_CACHE_DIR` override, else platform convention per R-04), then reports:

- `location` — the resolved directory (printed even if it does not exist)
- `entries` — files parsing as valid cache entries
- `corrupt` — `*.json` files that fail to parse as entries (counted, never deleted here)
- `size` — total bytes of all `*.json` entry files, rendered human (`12.4 kB`)
- freshness — `fresh` vs `expired` counts using the entry-TTL rule (`isFresh`, R-04)
  at invocation time
- `oldest` / `newest` — `fetchedAt` extremes among valid entries (omitted when empty)

Missing or empty directory is a normal state: zeros, exit 0. Unreadable directory:
one stderr warning (existing cache-degradation tone), zeros, exit 0.
`--json`: `{ location, exists, entries, corrupt, sizeBytes, fresh, expired, oldest,
newest }` (`oldest`/`newest` null when empty; keys always present, deterministic).

**`cache clear`** — deletes cache entry files: names matching `^[0-9a-f]{64}\.json$`
plus orphaned `*.json.tmp` from interrupted writes. Never deletes the directory itself,
never recurses, never touches non-matching files (defense against a mis-set
`SKILLWARDEN_CACHE_DIR` pointing somewhere meaningful).

Confirmation story: **no interactive prompt, ever** — mirroring `npm cache clean
--force`. Without `--yes` the command refuses deterministically (same behavior in
scripts and terminals; no TTY detection, nothing to hang CI). With `--yes` it deletes
and reports `cleared <n> cached responses (<size>) from <location>` (stdout).
Empty/missing directory with `--yes`: `cache is already empty` — exit 0.
Per-file deletion errors: warn on stderr, continue, report what was cleared; exit 0
unless nothing could be deleted at all (then exit 3, unavailable).
`--json` (with `--yes`): `{ location, cleared, freedBytes, failed }`.

## Error contract additions (PRD table format)

| Class                                                              | User-facing message (stderr)                                                       | Exit |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---- |
| `cache clear` without `--yes`                                      | `cache clear deletes <n> cached responses (<size>). Re-run with --yes to confirm.` | 2    |
| `cache clear` where nothing could be deleted (all attempts failed) | `Could not clear the cache at <location> (<detail>).`                              | 3    |

The refusal line computes `<n>`/`<size>` live, so the dry-run _is_ the confirmation
prompt: `cache clear` (no flag) doubles as a "what would this delete" query.

## Test expectations

- `info` on: missing dir, empty dir, mixed fresh/expired entries (fake clock), corrupt
  entries counted not deleted, `SKILLWARDEN_CACHE_DIR` override honored, `--json` shape.
- `clear` without `--yes`: refusal message with live count/size, exit 2, nothing
  deleted. With `--yes`: only matching files deleted (a planted `README.txt` and
  `notes.json` with non-hash names survive), `.tmp` orphans removed, report line, exit 0.
- Repeated `clear --yes` (already empty): exit 0 message.
- Command-level tests use temp dirs via `SKILLWARDEN_CACHE_DIR`; no fixture-server
  involvement (offline by definition).

## Non-goals

- Selective eviction (by URL, age, or route); cache warming/prefetch; TTL override
  (that is S-03's config file); `cache` acting on anything but the response cache
  (lockfiles and skill dirs are untouchable by this command).
