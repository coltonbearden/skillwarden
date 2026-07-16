# SPEC-WP1 — Release engineering: CI, release workflow, supply-chain hardening

## Problem

The repo has no CI and has never been published. Claims the docs make — "runs on
Node ≥ 20.10", "suite is offline", "works on Windows/macOS/Linux" — are verified only on
this one Windows machine with Node 24. Publishing must produce a provenance-attested
artifact, and the pipeline itself must meet the bar the tool sets for others: pinned
dependencies, least privilege, no secrets where none are needed.

## Open question 1 — Node-20 CI leg (resolved)

Type stripping (running `.ts` directly) is unavailable on Node 20 — it landed in 22.6
behind a flag and is default-on only from 22.18/23.6. `npm test` as-is fails on Node 20
for reasons unrelated to the shipped code. Only compiled `dist/` output is Node-20-valid.

Options considered:

- **(a) Minimal dist exercise** — `node dist/cli.js --version` + an offline `scan`.
  Cheap, but proves little beyond "the binary starts".
- **(b) Convert the integration smoke test to plain JS (`smoke.test.mjs`)** — the
  existing end-to-end test already spawns the **built binary** against a loopback
  fixture server and asserts on the full workflow (scan → pin → check → tamper → audit →
  429 retry → offline fallback). `node:test` is stable on Node 20; the only Node-20
  blocker is the test file's `.ts` extension. One artifact, no drift, full workflow
  proven on every leg.
- **(c) Compile the test suite to JS for Node 20** — needs a second tsconfig and emit
  pipeline for tests; heavyweight, and still exercises the suite's fake-clock unit
  paths rather than the shipped binary.

**Decision (log as D-12 at execution): option (b).** The smoke test becomes
`tests/integration/smoke.test.mjs` (plain JS, self-sufficient — the four fixture/temp
helpers it uses are extracted to a shared `.mjs` or inlined). Node 20 lacks glob support
in `node --test` arguments, so `test:integration` switches to the literal file path.
Full `.ts` unit suites run on the 22/24 legs.

## Open question 2 — publish mechanism (resolved)

Verified against current npm docs (2026-07-16, docs.npmjs.com):

- Trusted publishing **cannot be configured for a never-published name** — "the package
  you're configuring must already exist on the npm registry" (this also applies to the
  `npm trust` CLI command, npm ≥ 11.15).
- Under trusted publishing, provenance is generated **automatically** (no
  `--provenance` flag). Requires npm CLI ≥ 11.5.1, Node ≥ 22.14 in CI, `id-token: write`.
- A token-authenticated publish from GitHub Actions can still produce provenance with an
  explicit `npm publish --provenance`, which also requires `id-token: write`.

Options considered:

- **(a) Token-first, then flip to OIDC** — v0.1.0 publishes from the release workflow
  with a short-lived granular automation token (`NPM_TOKEN` secret) and explicit
  `--provenance`; immediately after, configure the trusted publisher on the package
  settings page, delete the token and secret, and flip the workflow to OIDC for v0.2.0+.
- **(b) Placeholder publish** — hand-publish a `0.0.0` placeholder to create the name,
  configure trusted publishing, then v0.1.0 goes out via OIDC. Pollutes the version
  history, and the placeholder itself ships without provenance.
- **(c) Local first publish** — `npm publish` from this machine. Simplest, but local
  publishes cannot produce provenance, violating the requirement that v0.1.0 itself is
  attested, and bypasses the release workflow entirely.

**Decision (log as D-11 at execution): option (a).** v0.1.0 is provenance-attested, goes
through the release workflow, creates no junk versions, and the token's exposure window
is one release. The workflow carries a comment marking the exact lines that change when
flipping to trusted publishing.

## Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-11 | `.github/workflows/ci.yml`: triggers on push to `main` and on pull requests. A `test` job with matrix `ubuntu-latest` / `windows-latest` / `macos-latest` × Node `20` / `22` / `24`, `fail-fast: false`: `npm ci`, `npm run build`, then — Node 22/24: `npm run test:unit` + `npm run test:integration`; Node 20: `npm run test:integration` only (the `.mjs` smoke over the built binary). A single `quality` job (ubuntu-latest, Node 24): `npm ci`, `npm run build`, `npm run lint`, `npm run format:check`. No secrets anywhere; the suite stays offline by design. Windows legs are first-class: they must run the same steps with no leg-specific conditionals beyond the Node-20 test selection.                                   |
| R-12 | `tests/integration/smoke.test.ts` is converted to `tests/integration/smoke.test.mjs` (plain JS, `node:test`, runs unmodified on Node ≥ 20). The `test:integration` npm script uses the literal file path (Node 20's `--test` takes no glob args). The full local gate (`npm test`) behavior is unchanged: build → unit (`.ts`) → integration (`.mjs`). Verified 2026-07-16: the CRLF-normalization tests construct CRLF bytes at runtime (`digestContent('a\r\nb\r\n')`, `parseFrontmatter('---\r\n…')`) and do not depend on checkout line endings — required to stay that way now that `.gitattributes` forces LF checkouts everywhere including CI.                                                                                    |
| R-13 | `.github/workflows/release.yml`: triggers on `v*` tags. Single job, `permissions: contents: read, id-token: write` (provenance is an OIDC-signed attestation regardless of auth mechanism). Steps: `npm ci`, `npm run build`, `npm run test:unit`, `npm run test:integration`, a guard step failing the job if the tag ≠ `v${package.json version}`, then `npm publish --provenance --access public` authenticated by the `NPM_TOKEN` secret (v0.1.0; see D-11). The lines that change for the OIDC flip are comment-marked. Node 24 on the release job (bundles npm ≥ 11.5.1, satisfying future trusted publishing).                                                                                                                     |
| R-14 | Supply-chain hardening: every action in every workflow is pinned by full commit SHA with a `# vX.Y.Z` comment. Every workflow declares a least-privilege top-level `permissions:` block (`contents: read` baseline). `.github/dependabot.yml` covers `npm` (dev deps are all that exist) and `github-actions`, weekly, grouped updates per ecosystem — Dependabot keeps the SHA pins current.                                                                                                                                                                                                                                                                                                                                             |
| R-15 | README gains a CI status badge (next to which the npm-version badge lands post-publish). A doc note (in the WP-1 plan's deliverable, `docs/RELEASE_OPS.md`) records: (a) branch-protection recommendation — apply only after CI is green on `main`; since the flow is direct-push-to-main, protect `main` with required status checks + "include administrators" **off** (blocking direct pushes would break the working agreement; a PR-per-WP flow is heavier than this solo project needs — noted as the alternative), with exact `gh api` commands; (b) repo settings to enable with exact `gh api` commands: secret scanning, push protection, Dependabot alerts (all free on public repos); (c) the numbered human checklist below. |

## Human checklist (R-13/R-15 deliverable — you run these)

1. Create the npm account (if none): https://www.npmjs.com/signup — use
   `inbox@coltonbearden.com`.
2. Enable 2FA (authenticator app) on the account — required for token creation.
3. Create a **granular access token**: Access Tokens → Generate New Token → Granular.
   Packages and scopes: **Read and write, all packages** (a never-published name cannot
   be selected in advance). Expiration: **7 days**. Enable **bypass 2FA for publish**
   (CI cannot answer OTP prompts).
4. Add it as a GitHub Actions secret named exactly **`NPM_TOKEN`**:
   `gh secret set NPM_TOKEN --repo FirstCastSolutions423/skillwarden`.
5. (After I confirm CI green and WP-2 done) run `git tag v0.1.0 && git push --tags`.
6. After v0.1.0 lands: on npmjs.com → package `skillwarden` → Settings → Trusted
   publishing: GitHub, repository `FirstCastSolutions423/skillwarden`, workflow
   `release.yml`, environment blank. Explicitly select the allowed action **npm
   publish** (configurations created after May 20, 2026 require at least one allowed
   action to be selected; do not enable stage publish).
7. Delete the granular token on npmjs.com and the `NPM_TOKEN` GitHub secret:
   `gh secret delete NPM_TOKEN --repo FirstCastSolutions423/skillwarden`.
8. Tell me it's done — I flip `release.yml` to OIDC (pre-marked lines) in the v0.2.0 cycle.
9. End state, after the flip: npmjs.com → package `skillwarden` → Settings → Publishing
   access → **Require two-factor authentication and disallow tokens** — the trusted
   publisher is then the only publish path.

## Error contract additions

None — WP-1 adds no CLI surface.

## Test expectations

- The converted `smoke.test.mjs` passes locally via `npm test` on this machine (Node 24)
  before any CI work lands, and its assertions are byte-for-byte the same scenario list
  as the `.ts` original.
- CI proves itself: all 9 matrix legs + quality job green on `main` is the acceptance
  test. The Windows × Node 20 leg specifically proves the `engines >= 20.10` claim on
  the platform where CRLF handling matters.
- Release workflow is proven by the v0.1.0 publish (human-gated).

## Non-goals

- Code coverage reporting, release-notes automation, changelog generation.
- Publishing docs sites or GitHub Releases artifacts (npm + git tag is the release).
- CI for anything but this package (no reusable workflows).
