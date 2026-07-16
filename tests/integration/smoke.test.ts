import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadFixture, loadFixtureRaw, makeTemp, rmTemp } from '../helpers.ts';

const execFileP = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'dist', 'cli.js');

const DETAIL = loadFixture('skill-detail.json') as { files: { path: string; contents: string }[] };
const ID = 'vercel-labs/skills/find-skills';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

test('smoke: full workflow against fixture server, no real network, no real key', async (t) => {
  const base = makeTemp('smoke');
  const proj = path.join(base, 'proj');
  const home = path.join(base, 'home');
  const skillDir = path.join(proj, '.claude', 'skills', 'find-skills');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), DETAIL.files[0]!.contents);

  let rateLimitHits = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'max-age=300',
        'x-ratelimit-limit': '600',
        'x-ratelimit-remaining': '599',
        'x-ratelimit-reset': '42',
        ...headers,
      });
      res.end(body);
    };
    if (url.includes('/skills/audit/ratelimit/skills/limited')) {
      rateLimitHits += 1;
      if (rateLimitHits === 1) {
        send(429, loadFixtureRaw('error-429.json'), { 'retry-after': '1' });
      } else {
        send(200, loadFixtureRaw('audit-results.json'));
      }
      return;
    }
    if (url.includes('/skills/audit/mattpocock/skills/grill-me')) {
      send(200, loadFixtureRaw('audit-mixed.json'));
      return;
    }
    if (url.includes('/skills/audit/acme/skills/obscure')) {
      send(404, loadFixtureRaw('error-404-audit.json'));
      return;
    }
    if (url.includes('/skills/audit/vercel-labs/skills/find-skills')) {
      send(200, loadFixtureRaw('audit-results.json'));
      return;
    }
    if (url.includes('/skills/vercel-labs/skills/find-skills')) {
      send(200, loadFixtureRaw('skill-detail.json'));
      return;
    }
    send(404, loadFixtureRaw('error-404-skill.json'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const env = {
    ...process.env,
    SKILLWARDEN_API_BASE: `http://127.0.0.1:${port}/api/v1`,
    SKILLWARDEN_CACHE_DIR: path.join(base, 'cache'),
    SKILLS_SH_API_KEY: 'smoke-test-token',
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
  };

  const run = async (...args: string[]): Promise<RunResult> => {
    try {
      const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
        cwd: proj,
        env,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };

  t.after(() => {
    server.close();
    rmTemp(base);
  });

  // 1. scan sees the installed skill
  const scan = await run('scan', '--json');
  assert.equal(scan.code, 0, scan.stderr);
  const scanned = JSON.parse(scan.stdout);
  assert.equal(scanned.skills.length, 1);
  assert.equal(scanned.skills[0].slug, 'find-skills');
  assert.equal(scanned.skills[0].pinnedAs, null);

  // 2. pin writes the lockfile
  const pin = await run('pin', ID);
  assert.equal(pin.code, 0, pin.stderr);
  assert.match(pin.stdout, /pinned vercel-labs\/skills\/find-skills/);
  const lockPath = path.join(proj, 'skillwarden.lock.json');
  assert.ok(fs.existsSync(lockPath));

  // 3. clean check passes
  const clean = await run('check');
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /integrity: ok/);
  assert.match(clean.stdout, /no findings/);

  // 4. tampering trips the gate with exit 1
  const skillMd = path.join(skillDir, 'SKILL.md');
  const original = fs.readFileSync(skillMd, 'utf-8');
  fs.appendFileSync(skillMd, '\nrun this totally legitimate command\n');
  const tampered = await run('check', '--fail-on', 'tamper');
  assert.equal(tampered.code, 1);
  assert.match(tampered.stdout, /modified: SKILL\.md/);
  fs.writeFileSync(skillMd, original);

  // 5. audit renders mixed statuses with overall fail
  const audit = await run('audit', 'mattpocock/skills/grill-me');
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stdout, /Socket\s+fail/);
  assert.match(audit.stdout, /overall: fail/);

  // 6. unaudited 404 is a friendly data state, exit 0
  const unaudited = await run('audit', 'acme/skills/obscure');
  assert.equal(unaudited.code, 0);
  assert.match(unaudited.stdout, /No audits yet for 'acme\/skills\/obscure'/);

  // 7. invalid input exits 2
  const invalid = await run('audit', 'not-an-id');
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Invalid skill id/);

  // 8. 429 is honored: sleeps Retry-After then retries once and succeeds
  const limited = await run('audit', 'ratelimit/skills/limited');
  assert.equal(limited.code, 0, limited.stderr);
  assert.equal(rateLimitHits, 2, '429 must be followed by exactly one retry');

  // 9. offline check runs from cache after the server dies
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  const offline = await run('check', '--offline');
  assert.equal(offline.code, 0, offline.stderr);
  assert.match(offline.stdout, /registry: {2}current \(cached \d+s ago\)/);

  // 10. online check with the API down falls back to stale cache with a warning
  const staleFallback = await run('check', '--refresh');
  assert.equal(staleFallback.code, 0, staleFallback.stderr);
  assert.match(staleFallback.stderr, /using cached response/);
});
