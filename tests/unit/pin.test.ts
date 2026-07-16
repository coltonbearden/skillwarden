import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPin, type PinFlags } from '../../src/commands/pin.ts';
import { readLockfile } from '../../src/core/lockfile.ts';
import { digestContent } from '../../src/core/discovery.ts';
import { CliError } from '../../src/output/errors.ts';
import { loadFixture, loadFixtureRaw, makeTemp, rmTemp, writeSkill } from '../helpers.ts';
import type { CommandContext } from '../../src/context.ts';

const NOW = new Date('2026-07-15T18:00:00Z');
const DETAIL = loadFixture('skill-detail.json') as { files: { path: string; contents: string }[] };

function routes(url: string): { status: number; body: string } {
  if (url.includes('/skills/audit/vercel-labs/skills/find-skills')) {
    return { status: 200, body: loadFixtureRaw('audit-results.json') };
  }
  if (url.includes('/skills/audit/')) {
    return { status: 404, body: loadFixtureRaw('error-404-audit.json') };
  }
  if (url.includes('/skills/vercel-labs/skills/find-skills')) {
    return { status: 200, body: loadFixtureRaw('skill-detail.json') };
  }
  if (url.includes('/skills/wshobson/agents/nextjs-app-router-patterns')) {
    return { status: 200, body: loadFixtureRaw('skill-detail-nosnapshot.json') };
  }
  return { status: 404, body: loadFixtureRaw('error-404-skill.json') };
}

function makeCtx(base: string) {
  const cwd = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd,
    home,
    env: {
      SKILLWARDEN_API_BASE: 'https://api.test/api/v1',
      SKILLWARDEN_CACHE_DIR: path.join(base, 'cache'),
      SKILLS_SH_API_KEY: 'test-token',
    },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    fetchImpl: (async (input: string | URL | Request) => {
      const r = routes(String(input));
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
      });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    isTTY: false,
  };
  return { ctx, cwd, home, out, err };
}

const flags = (over: Partial<PinFlags> = {}): PinFlags => ({
  json: false,
  noColor: true,
  verbose: false,
  offline: false,
  refresh: false,
  all: false,
  ...over,
});

test('pin snapshots registry files, hash, and audits into the lockfile', async () => {
  const t = makeTemp('pin');
  try {
    const { ctx, cwd, out } = makeCtx(t);
    writeSkill(path.join(cwd, '.claude', 'skills'), 'find-skills', DETAIL.files[0]!.contents);
    const code = await runPin(['vercel-labs/skills/find-skills'], flags(), ctx);
    assert.equal(code, 0);
    assert.match(out.join('\n'), /pinned vercel-labs\/skills\/find-skills/);
    const lf = readLockfile(cwd)!;
    const pin = lf.skills['vercel-labs/skills/find-skills']!;
    assert.equal(pin.snapshot, 'registry');
    assert.equal(pin.dir, '.claude/skills/find-skills');
    assert.equal(pin.files['SKILL.md'], digestContent(DETAIL.files[0]!.contents));
    assert.match(pin.registryHash!, /^[0-9a-f]{64}$/);
    assert.equal(pin.audits['socket']!.status, 'pass');
  } finally {
    rmTemp(t);
  }
});

test('files:null pins the local fingerprint with snapshot local and unaudited audits', async () => {
  const t = makeTemp('pin-null');
  try {
    const { ctx, cwd } = makeCtx(t);
    writeSkill(path.join(cwd, '.claude', 'skills'), 'nextjs-app-router-patterns', '# local\n', {
      'extra.md': 'more',
    });
    const code = await runPin(['wshobson/agents/nextjs-app-router-patterns'], flags(), ctx);
    assert.equal(code, 0);
    const pin = readLockfile(cwd)!.skills['wshobson/agents/nextjs-app-router-patterns']!;
    assert.equal(pin.snapshot, 'local');
    assert.equal(pin.registryHash, null);
    assert.deepEqual(Object.keys(pin.files).sort(), ['SKILL.md', 'extra.md']);
    assert.deepEqual(pin.audits, {});
  } finally {
    rmTemp(t);
  }
});

test('unknown registry id exits 1 and does not write a lockfile', async () => {
  const t = makeTemp('pin-404');
  try {
    const { ctx, cwd, err } = makeCtx(t);
    writeSkill(path.join(cwd, '.claude', 'skills'), 'ghost', '# g');
    const code = await runPin(['acme/skills/ghost'], flags(), ctx);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /not found in the registry/);
    assert.equal(readLockfile(cwd), null);
  } finally {
    rmTemp(t);
  }
});

test('no matching local dir exits 1 with --dir hint; ambiguity exits 2', async () => {
  const t = makeTemp('pin-dirs');
  try {
    const { ctx, cwd, err } = makeCtx(t);
    const code = await runPin(['vercel-labs/skills/find-skills'], flags(), ctx);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /no local directory named 'find-skills'/);

    writeSkill(path.join(cwd, '.claude', 'skills'), 'find-skills', 'a');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'find-skills', 'b');
    const code2 = await runPin(['vercel-labs/skills/find-skills'], flags(), ctx);
    assert.equal(code2, 2);
    assert.match(err.join('\n'), /multiple local directories/);
  } finally {
    rmTemp(t);
  }
});

test('pin --all re-pins lockfile entries; --all with no lockfile is usage error', async () => {
  const t = makeTemp('pin-all');
  try {
    const { ctx, cwd } = makeCtx(t);
    writeSkill(path.join(cwd, '.claude', 'skills'), 'find-skills', DETAIL.files[0]!.contents);
    await runPin(['vercel-labs/skills/find-skills'], flags(), ctx);
    const code = await runPin([], flags({ all: true, refresh: true }), ctx);
    assert.equal(code, 0);

    const empty = makeCtx(makeTemp('pin-all2'));
    await assert.rejects(
      runPin([], flags({ all: true }), empty.ctx),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  } finally {
    rmTemp(t);
  }
});

test('invalid id and flag combinations are usage errors', async () => {
  const t = makeTemp('pin-usage');
  try {
    const { ctx } = makeCtx(t);
    await assert.rejects(
      runPin([], flags(), ctx),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
    await assert.rejects(
      runPin(['not-an-id'], flags(), ctx),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
    await assert.rejects(
      runPin(['a/b/c', 'd/e/f'], flags({ dir: 'somewhere' }), ctx),
      (e: unknown) => e instanceof CliError && e.exitCode === 2 && /exactly one/.test(e.message),
    );
  } finally {
    rmTemp(t);
  }
});

test('missing token surfaces exit 4 per-id error', async () => {
  const t = makeTemp('pin-auth');
  try {
    const { ctx, cwd, err } = makeCtx(t);
    delete ctx.env['SKILLS_SH_API_KEY'];
    ctx.fetchImpl = (async () =>
      new Response(loadFixtureRaw('error-401.json'), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    writeSkill(path.join(cwd, '.claude', 'skills'), 'find-skills', 'x');
    const code = await runPin(['vercel-labs/skills/find-skills'], flags(), ctx);
    assert.equal(code, 4);
    assert.match(err.join('\n'), /Set SKILLS_SH_API_KEY/);
  } finally {
    rmTemp(t);
  }
});
