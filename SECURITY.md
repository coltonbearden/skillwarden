# Security Policy

skillwarden is a supply-chain hygiene tool; reports about its own security
are taken seriously and handled with priority.

## Reporting a vulnerability

**Do not open a public issue for security reports.**

- Preferred: [GitHub private vulnerability reporting](https://github.com/FirstCastSolutions423/skillwarden/security/advisories/new)
- Email: inbox@coltonbearden.com (subject line starting with `[skillwarden security]`)

You will receive an acknowledgment within **72 hours**. Expect a triage
verdict (accepted / declined / needs info) within **7 days**, and — for
accepted reports — a fix or documented mitigation targeted within **90
days**, usually much sooner. You will be credited in the release notes
unless you ask otherwise.

## Scope

In scope:

- The `skillwarden` npm package: CLI, lockfile reading/writing, local file
  discovery and fingerprinting, the disk response cache, and the API client
  (including how it handles `SKILLS_SH_API_KEY`).
- Integrity of the published artifact (provenance, tampered releases).
- Anything that could make `check` report `ok` for tampered skill files, or
  otherwise defeat the pin/verify/gate loop.

Out of scope:

- The skills.sh service and API themselves (report to their operators).
- The content or behavior of third-party skills that skillwarden inventories.
- Vulnerabilities requiring an already-compromised machine or write access
  to the repository.

## Supported versions

Only the latest published release receives security fixes.
