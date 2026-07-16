import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheck, type CheckFlags } from '../../src/commands/check.ts';
import { runPin, type PinFlags } from '../../src/commands/pin.ts';
import { CliError } from '../../src/output/errors.ts';
import { loadFixture, loadFixtureRaw, makeTemp, rmTemp, writeSkill } from '../helpers.ts';
import type { CommandContext } from '../../src/context.ts';

const NOW = new Date('2026-07-15T18:00:00Z');
const DETAIL = loadFixture('skill-detail.json') as { files: { path: string; contents: string }[] };
const SKILL_CONTENT = DETAIL.files[0]!.contents;
const ID = 'vercel-labs/skills/find-skills';

type Router = (url: string) => { status: number; body: string } | 'network-error';

function makeCtx(base: string, route: Router) {
  const cwd = path.join(base, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd,
    home: path.join(base, 'home'),
    env: {
      SKILLWARDEN_API_BASE: 'https://api.test/api/v1',
      SKILLWARDEN_CACHE_DIR: path.join(base, 'cache'),
      SKILLS_SH_API_KEY: 'test-token',
    },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    fetchImpl: (async (input: string | URL | Request) => {
      const r = route(String(input));
      if (r === 'network-error') throw new TypeError('fetch failed');
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
      });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    isTTY: false,
  };
  return { ctx, cwd, out, err };
}

const defaultRoute: Router = (url) => {
  if (url.includes('/skills/audit/')) return { status: 200, body: loadFixtureRaw('audit-results.json') };
  return { status: 200, body: loadFixtureRaw('skill-detail.json') };
};

const pinFlags = (over: Partial<PinFlags> = {}): PinFlags => ({
  json: false, noColor: true, verbose: false, offline: false, refresh: false, all: false, ...over,
});
const checkFlags = (over: Partial<CheckFlags> = {}): CheckFlags => ({
  json: false, noColor: true, verbose: false, offline: false, refresh: false, ...over,
});

async function pinnedWorkspace(base: string, route: Router = defaultRoute) {
  const ws = makeCtx(base, route);
  writeSkill(path.join(ws.cwd, '.claude', 'skills'), 'find-skills', SKILL_CONTENT);
  const code = await runPin([ID], pinFlags(), ws.ctx);
  assert.equal(code, 0);
  ws.out.length = 0;
  ws.err.length = 0;
  return ws;
}

test('check without a lockfile is exit 2 with pin hint', async () => {
  const t = makeTemp('chk-nolock');
  try {
    const { ctx } = makeCtx(t, defaultRoute);
    await assert.rejects(
      runCheck(checkFlags(), ctx),
      (e: unknown) =>
        e instanceof CliError && e.exitCode === 2 && /No skillwarden\.lock\.json/.test(e.message),
    );
  } finally {
    rmTemp(t);
  }
});

test('clean workspace passes: ok/current/pass, exit 0', async () => {
  const t = makeTemp('chk-clean');
  try {
    const ws = await pinnedWorkspace(t);
    const code = await runCheck(checkFlags(), ws.ctx);
    assert.equal(code, 0);
    const text = ws.out.join('\n');
    assert.match(text, /integrity: ok/);
    assert.match(text, /registry: {2}current/);
    assert.match(text, /audits: {4}pass/);
    assert.match(text, /no findings/);
  } finally {
    rmTemp(t);
  }
});

test('tampered file fails under default policy with exit 1', async () => {
  const t = makeTemp('chk-tamper');
  try {
    const ws = await pinnedWorkspace(t);
    fs.appendFileSync(
      path.join(ws.cwd, '.claude', 'skills', 'find-skills', 'SKILL.md'),
      '\ninjected instruction\n',
    );
    const code = await runCheck(checkFlags(), ws.ctx);
    assert.equal(code, 1);
    const text = ws.out.join('\n');
    assert.match(text, /integrity: modified — modified: SKILL\.md/);
    assert.match(text, /FAIL on \[tamper,audit-fail\]/);
  } finally {
    rmTemp(t);
  }
});

test('upstream drift is visible but passes default policy; --fail-on drift gates it', async () => {
  const t = makeTemp('chk-drift');
  try {
    const ws = await pinnedWorkspace(t);
    const drifted = JSON.parse(loadFixtureRaw('skill-detail.json'));
    drifted.hash = 'ff'.repeat(32);
    ws.ctx.fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/skills/audit/')
        ? loadFixtureRaw('audit-results.json')
        : JSON.stringify(drifted);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=0' },
      });
    }) as typeof fetch;

    const okCode = await runCheck(checkFlags({ refresh: true }), ws.ctx);
    assert.equal(okCode, 0);
    assert.match(ws.out.join('\n'), /update-available/);

    ws.out.length = 0;
    const failCode = await runCheck(checkFlags({ refresh: true, failOn: 'tamper,drift' }), ws.ctx);
    assert.equal(failCode, 1);
  } finally {
    rmTemp(t);
  }
});

test('audit regression to fail gates under default policy', async () => {
  const t = makeTemp('chk-reg');
  try {
    const ws = await pinnedWorkspace(t);
    ws.ctx.fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/skills/audit/')
        ? loadFixtureRaw('audit-mixed.json')
        : loadFixtureRaw('skill-detail.json');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=0' },
      });
    }) as typeof fetch;
    const code = await runCheck(checkFlags({ refresh: true }), ws.ctx);
    assert.equal(code, 1);
    const text = ws.out.join('\n');
    assert.match(text, /audits: {4}fail/);
    assert.match(text, /regressed since pin/);
  } finally {
    rmTemp(t);
  }
});

test('tokenless check runs integrity only, planes unknown, exit 0 under default policy', async () => {
  const t = makeTemp('chk-notok');
  try {
    const ws = await pinnedWorkspace(t);
    delete ws.ctx.env['SKILLS_SH_API_KEY'];
    const code = await runCheck(checkFlags(), ws.ctx);
    assert.equal(code, 0);
    assert.match(ws.err.join('\n'), /no SKILLS_SH_API_KEY/);
    const text = ws.out.join('\n');
    assert.match(text, /registry: {2}unknown/);
    assert.match(text, /audits: {4}unknown/);
    assert.match(text, /integrity: ok/);
  } finally {
    rmTemp(t);
  }
});

test('check --offline serves cached planes with age annotation', async () => {
  const t = makeTemp('chk-off');
  try {
    const ws = await pinnedWorkspace(t); // pin populated the cache
    ws.ctx.fetchImpl = (async () => {
      throw new Error('offline test must not fetch');
    }) as typeof fetch;
    ws.ctx.now = () => new Date('2026-07-15T18:30:00Z');
    const code = await runCheck(checkFlags({ offline: true }), ws.ctx);
    assert.equal(code, 0);
    const text = ws.out.join('\n');
    assert.match(text, /registry: {2}current \(cached 1800s ago\)/);
    assert.match(text, /audits: {4}pass \(cached 1800s ago\)/);
  } finally {
    rmTemp(t);
  }
});

test('check --offline with cold cache reports unknown planes and completes', async () => {
  const t = makeTemp('chk-cold');
  try {
    const ws = await pinnedWorkspace(t);
    ws.ctx.env['SKILLWARDEN_CACHE_DIR'] = path.join(t, 'cold-cache');
    const code = await runCheck(checkFlags({ offline: true }), ws.ctx);
    assert.equal(code, 0);
    const text = ws.out.join('\n');
    assert.match(text, /registry: {2}unknown/);
    assert.match(text, /audits: {4}unknown/);
  } finally {
    rmTemp(t);
  }
});

test('gone skill and not-pinned local skills are reported', async () => {
  const t = makeTemp('chk-gone');
  try {
    const ws = await pinnedWorkspace(t);
    writeSkill(path.join(ws.cwd, '.claude', 'skills'), 'stray', '# stray');
    ws.ctx.fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/skills/audit/')
        ? loadFixtureRaw('error-404-audit.json')
        : loadFixtureRaw('error-404-skill.json');
      return new Response(body, {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const code = await runCheck(checkFlags({ refresh: true, failOn: 'gone' }), ws.ctx);
    assert.equal(code, 1);
    const text = ws.out.join('\n');
    assert.match(text, /registry: {2}gone — no longer in the registry/);
    assert.match(text, /not in the lockfile/);
    assert.match(text, /stray/);
  } finally {
    rmTemp(t);
  }
});

test('mid-check API failure aborts rather than reporting half-clean', async () => {
  const t = makeTemp('chk-abort');
  try {
    const ws = await pinnedWorkspace(t);
    ws.ctx.fetchImpl = (async () =>
      new Response(loadFixtureRaw('error-429.json'), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      })) as typeof fetch;
    await assert.rejects(
      runCheck(checkFlags({ refresh: true }), ws.ctx),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && /Try again in 7s/.test(e.message),
    );
  } finally {
    rmTemp(t);
  }
});

test('check --json emits policy verdict and full report', async () => {
  const t = makeTemp('chk-json');
  try {
    const ws = await pinnedWorkspace(t);
    const code = await runCheck(checkFlags({ json: true }), ws.ctx);
    assert.equal(code, 0);
    const parsed = JSON.parse(ws.out.join('\n'));
    assert.equal(parsed.command, 'check');
    assert.deepEqual(parsed.policy, ['tamper', 'audit-fail']);
    assert.equal(parsed.verdict.failed, false);
    assert.equal(parsed.skills[0].id, ID);
    assert.equal(parsed.skills[0].integrity.state, 'ok');
  } finally {
    rmTemp(t);
  }
});
