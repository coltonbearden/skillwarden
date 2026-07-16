# Release ops

## 1. Branch protection

Apply only after CI is green on `main`; compatible with the direct-push-to-main flow
(`enforce_admins: false` keeps admin pushes working; a PR-per-WP flow was rejected as
heavier than a solo project needs):

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

## 2. Repo security settings

Free on public repos:

```bash
gh api -X PATCH repos/FirstCastSolutions423/skillwarden --input - <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
gh api -X PUT repos/FirstCastSolutions423/skillwarden/vulnerability-alerts
```

## 3. Publish checklist

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
