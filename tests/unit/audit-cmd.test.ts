import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAudit } from '../../src/commands/audit.ts';
import { CliError } from '../../src/output/errors.ts';
import { loadFixtureRaw, makeTemp, rmTemp } from '../helpers.ts';
import type { CommandContext, GlobalFlags } from '../../src/context.ts';

const NOW = new Date('2026-07-15T18:00:00Z');

function makeCtx(base: string, route: (url: string) => { status: number; body: string }) {
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
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
      });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    isTTY: false,
  };
  return { ctx, out, err };
}

const flags = (over: Partial<GlobalFlags> = {}): GlobalFlags => ({
  json: false,
  noColor: true,
  verbose: false,
  offline: false,
  refresh: false,
  ...over,
});

test('mixed audits render per-partner rows with overall fail', async () => {
  const t = makeTemp('aud');
  try {
    const { ctx, out } = makeCtx(t, () => ({
      status: 200,
      body: loadFixtureRaw('audit-mixed.json'),
    }));
    const code = await runAudit(['mattpocock/skills/grill-me'], flags(), ctx);
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /Socket\s+fail\s+HIGH/);
    assert.match(text, /Gen Agent Trust Hub\s+warn\s+MEDIUM/);
    assert.match(text, /\[tool-abuse\]/);
    assert.match(text, /overall: fail \(worst of 3 partners\)/);
  } finally {
    rmTemp(t);
  }
});

test('unaudited skill prints the data-state message and exits 0', async () => {
  const t = makeTemp('aud-404');
  try {
    const { ctx, out } = makeCtx(t, () => ({
      status: 404,
      body: loadFixtureRaw('error-404-audit.json'),
    }));
    const code = await runAudit(['acme/skills/obscure'], flags(), ctx);
    assert.equal(code, 0);
    assert.match(
      out.join('\n'),
      /No audits yet for 'acme\/skills\/obscure' — audits are generated automatically shortly after a skill's first install\./,
    );
  } finally {
    rmTemp(t);
  }
});

test('audit --json emits the full model including unaudited overall', async () => {
  const t = makeTemp('aud-json');
  try {
    const { ctx, out } = makeCtx(t, () => ({
      status: 404,
      body: loadFixtureRaw('error-404-audit.json'),
    }));
    const code = await runAudit(['acme/skills/obscure'], flags({ json: true }), ctx);
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join('\n'));
    assert.equal(parsed.command, 'audit');
    assert.equal(parsed.overall, 'unaudited');
    assert.deepEqual(parsed.partners, []);
  } finally {
    rmTemp(t);
  }
});

test('zero or multiple ids is a usage error, exit 2', async () => {
  const t = makeTemp('aud-usage');
  try {
    const { ctx } = makeCtx(t, () => ({ status: 200, body: '{}' }));
    for (const ids of [[], ['a/b/c', 'd/e/f']]) {
      await assert.rejects(
        runAudit(ids, flags(), ctx),
        (e: unknown) => e instanceof CliError && e.exitCode === 2,
      );
    }
  } finally {
    rmTemp(t);
  }
});
