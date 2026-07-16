# WP-1 — Release engineering: implementation plan

> **For agentic workers:** execute via superpowers:subagent-driven-development — fresh
> subagent per task, full gate (`npm test`, `npm run lint`, `npm run format:check`)
> after each task, one conventional commit each. Task text + SPEC-WP1 slices are the
> whole context a subagent gets.

**Goal:** CI proving the matrix claims (3 OS × Node 20/22/24), a provenance release
workflow, and supply-chain hardening — per `docs/specs/SPEC-WP1.md` (R-11…R-15).

**Architecture:** the Node-20 leg runs only compiled `dist/` output, so the end-to-end
smoke test converts to plain JS first (D-12); workflows are least-privilege and
SHA-pinned; the release publishes v0.1.0 with a token + `--provenance` (D-11), with the
OIDC flip pre-marked.

## Global constraints

- Zero runtime dependencies; the suite passes with no network and no token at every commit.
- No secrets in `ci.yml`; `release.yml` uses only `NPM_TOKEN` (until the OIDC flip).
- Every action pinned by full commit SHA + `# vX.Y.Z` comment.
- Conventional Commits; full gate green before each commit.

Execution order = task number order.

### W1-T1 — smoke test to plain JS [M] (R-12) — deps: none

**Files:** create `tests/helpers.mjs`; modify `tests/helpers.ts`; create
`tests/integration/smoke.test.mjs`; delete `tests/integration/smoke.test.ts`; modify
`package.json` (`test:integration`).

`tests/helpers.mjs` — move these four helpers verbatim from `tests/helpers.ts`, types
stripped (they are the only ones the smoke test imports):

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixturePath(name) {
  return path.join(FIXTURES, name);
}
export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(fixturePath(name), 'utf-8'));
}
export function loadFixtureRaw(name) {
  return fs.readFileSync(fixturePath(name), 'utf-8');
}
export function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skillwarden-${prefix}-`));
}
export function rmTemp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
```

`tests/helpers.ts` — delete those five definitions and replace with a re-export so the
`.ts` unit suites keep their imports unchanged:

```ts
export { fixturePath, loadFixture, loadFixtureRaw, makeTemp, rmTemp } from './helpers.mjs';
```

(`writeSkill`, `linkDir`, `fakeSleep` stay in `helpers.ts`.)

`tests/integration/smoke.test.mjs` — port of `smoke.test.ts` with type syntax removed:
drop the `RunResult` interface and every type annotation/`as`-cast (`(server.address()).port`,
`err.code ?? -1` stay as plain JS); imports change to
`from '../helpers.mjs'`. **Assertions and scenario order stay byte-identical** — this is
a mechanical conversion, not a rewrite.

`package.json`: `"test:integration": "node --test tests/integration/smoke.test.mjs"`
(literal path — Node 20's `--test` takes no glob arguments).

**Interfaces produced:** `tests/helpers.mjs` exporting `fixturePath`, `loadFixture`,
`loadFixtureRaw`, `makeTemp`, `rmTemp` (consumed by W1-T2's CI and the WP-3/WP-4 smoke
extensions).

**Edge cases:** eslint flat config must lint (or explicitly ignore) `.mjs` without
errors; prettier already formats `.mjs`. If `tsc` (build includes only `src/`) or
typescript-eslint complains about the `.mjs` re-export, fix config narrowly — do not
convert other helpers.

**TDD ordering:** the smoke test is its own test. (1) create `helpers.mjs` + re-export,
run `npm run test:unit` → green (unit suites unaffected); (2) port smoke, delete the
`.ts`, update `package.json`; (3) `npm test` → 113 tests green; (4) full gate.

**Verify:** `npm test` green; `git grep -l "smoke.test.ts"` → no hits outside docs.
**Commit:** `test: convert integration smoke to plain JS for Node 20 (D-12)`

### W1-T2 — CI workflow [S] (R-11, R-14 partial) — deps: W1-T1

**Files:** create `.github/workflows/ci.yml` with exactly:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci
      - run: npm run build
      - run: npm run lint
      - run: npm run format:check

  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [20, 22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm run build
      - name: Unit tests (.ts via type stripping, Node 22+ only — see D-12)
        if: matrix.node != 20
        run: npm run test:unit
      - name: Integration smoke (built binary, plain JS, all Node versions)
        run: npm run test:integration
```

SHAs above resolved 2026-07-16: `actions/checkout` v7.0.0 =
`9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`; `actions/setup-node` v7.0.0 =
`820762786026740c76f36085b0efc47a31fe5020`. Re-verify before committing:
`gh api repos/actions/checkout/git/ref/tags/v7.0.0 --jq .object.sha`.

**Interfaces produced:** check-run names `quality` and `test (<os>, <node>)` × 9 —
consumed verbatim by W1-T5's branch-protection contexts.

**Edge cases:** Windows legs run identical steps (no shell-specific syntax — the guard
scripts in release.yml use bash explicitly; ci.yml needs none); no secrets referenced;
matrix runs even when quality fails (`fail-fast: false`, independent jobs).

**Verify:** `npx prettier --check .github/workflows/ci.yml`; YAML parses
(`node -e "..."` not needed — actionlint unavailable, CI itself is the test).
**Commit:** `ci: 3-OS x Node 20/22/24 matrix + quality job, SHA-pinned (R-11)`

### W1-T3 — Dependabot [S] (R-14) — deps: none

**Files:** create `.github/dependabot.yml` with exactly:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      dev-dependencies:
        patterns: ['*']
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ['*']
```

**Verify:** prettier clean.
**Commit:** `ci: dependabot for npm dev deps and action SHA pins (R-14)`

### W1-T4 — release workflow [S] (R-13, R-14 partial) — deps: W1-T1

**Files:** create `.github/workflows/release.yml` with exactly:

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write # provenance attestation — required with a token AND under trusted publishing

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24 # bundles npm >= 11.5.1 — the floor for the trusted-publishing flip
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - run: npm ci
      - run: npm run build
      - run: npm run test:unit
      - run: npm run test:integration
      - name: Guard - tag must equal package.json version
        shell: bash
        run: |
          pkg="v$(node -p "require('./package.json').version")"
          if [ "${GITHUB_REF_NAME}" != "${pkg}" ]; then
            echo "Tag ${GITHUB_REF_NAME} does not match package version ${pkg}" >&2
            exit 1
          fi
      - name: Publish to npm with provenance
        # OIDC FLIP (v0.2.0 cycle, after the trusted publisher is configured and
        # NPM_TOKEN is deleted): remove the env: block below. Nothing else changes —
        # provenance becomes automatic under trusted publishing.
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Edge cases:** the guard runs under `shell: bash` explicitly (ubuntu default, but
explicit beats implicit for a release gate); `package-manager-cache: false` per the
approved amendment — a release must not trust a warm cache; tag push with mismatched
version fails **before** publish.

**Verify:** prettier clean; workflow appears under Actions after push (skipped — no tag).
**Commit:** `ci: tag-triggered npm publish with provenance, OIDC flip pre-marked (R-13, D-11)`

### W1-T5 — badge, release-ops doc, decision rows [S] (R-15) — deps: W1-T2, W1-T4

**Files:** modify `README.md` (badge line directly under the `# skillwarden` H1);
create `docs/RELEASE_OPS.md`; modify `docs/DECISIONS.md` (append D-11, D-12 rows).

Badge line:

```markdown
[![CI](https://github.com/FirstCastSolutions423/skillwarden/actions/workflows/ci.yml/badge.svg)](https://github.com/FirstCastSolutions423/skillwarden/actions/workflows/ci.yml)
```

(The npm-version badge lands beside it in the post-publish doc refresh, not now.)

`docs/RELEASE_OPS.md` sections:

1. **Branch protection** — apply only after CI is green on `main`; compatible with the
   direct-push-to-main flow (`enforce_admins: false` keeps admin pushes working; PR
   flow rejected as heavier than a solo project needs):

   ```bash
   gh api -X PUT repos/FirstCastSolutions423/skillwarden/branches/main/protection --input - <<'JSON'
   {
     "required_status_checks": {
       "strict": false,
       "contexts": [
         "quality",
         "test (ubuntu-latest, 20)", "test (ubuntu-latest, 22)", "test (ubuntu-latest, 24)",
         "test (windows-latest, 20)", "test (windows-latest, 22)", "test (windows-latest, 24)",
         "test (macos-latest, 20)", "test (macos-latest, 22)", "test (macos-latest, 24)"
       ]
     },
     "enforce_admins": false,
     "required_pull_request_reviews": null,
     "restrictions": null,
     "allow_force_pushes": false,
     "allow_deletions": false
   }
   JSON
   ```

2. **Repo security settings** (free on public repos):

   ```bash
   gh api -X PATCH repos/FirstCastSolutions423/skillwarden --input - <<'JSON'
   { "security_and_analysis": {
       "secret_scanning": { "status": "enabled" },
       "secret_scanning_push_protection": { "status": "enabled" } } }
   JSON
   gh api -X PUT repos/FirstCastSolutions423/skillwarden/vulnerability-alerts
   ```

3. **Publish checklist** — copy the 9-step human checklist from SPEC-WP1 verbatim.

`docs/DECISIONS.md` — append two rows in the established table format:

- **D-11** | v0.1.0 publishes from the release workflow via a short-lived granular
  `NPM_TOKEN` + explicit `npm publish --provenance`; the workflow flips to OIDC trusted
  publishing immediately after (token deleted, publishing access set to
  require-2FA-and-disallow-tokens). | Alternatives: placeholder `0.0.0` publish;
  local first publish. | Trusted publishing cannot be configured for a never-published
  name (docs.npmjs.com, verified 2026-07-16); a local publish cannot produce provenance;
  a placeholder pollutes version history unattested. Token path keeps v0.1.0 attested
  through the real workflow with a one-release exposure window.
- **D-12** | The Node-20 CI leg runs the integration smoke (converted to plain JS) over
  compiled `dist/` only; `.ts` unit suites run on 22/24. | Alternatives: minimal
  `--version` exercise; compiling the test suite. | Type stripping does not exist on
  Node 20; the smoke test already drives the shipped binary end-to-end, so converting
  it proves the `engines >= 20.10` claim with zero duplicate harness.

**Verify:** full gate (docs only, but prettier checks markdown).
**Commit:** `docs: CI badge, release ops runbook, D-11/D-12 decision rows (R-15)`

### W1-T6 — push and prove the matrix [S] (R-11 acceptance) — deps: all above

Push `main`; watch: `gh run list --repo FirstCastSolutions423/skillwarden --limit 5`
then `gh run watch <id> --exit-status`. Every failing leg gets a narrowly-scoped fix
commit (conventional, gate-green locally first). Done when `quality` + all 9 `test`
legs are green on `main`.

**Verify:** `gh run view <id> --json conclusion --jq .conclusion` → `success`.
**Commit:** none (or fix commits as needed).

## Self-review

R-11→W1-T2+W1-T6; R-12→W1-T1; R-13→W1-T4; R-14→W1-T2+W1-T3+W1-T4; R-15→W1-T5. Names
consistent: `test:integration` script (T1) is what ci.yml/release.yml invoke (T2/T4);
check-run names in T2 match T5's protection contexts; SHAs identical across T2/T4.

## Non-goals

Version bumps (v0.2.0 is a later cycle); GitHub Releases; coverage; actionlint.
