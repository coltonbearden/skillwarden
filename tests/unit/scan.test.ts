import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runScan, type ScanFlags } from '../../src/commands/scan.ts';
import { emptyLockfile, upsertPin, writeLockfile } from '../../src/core/lockfile.ts';
import { CliError } from '../../src/output/errors.ts';
import { makeTemp, rmTemp, writeSkill } from '../helpers.ts';
import type { CommandContext } from '../../src/context.ts';

const NOW = new Date('2026-07-15T18:00:00Z');

export function testCtx(cwd: string, home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd,
    home,
    env: {},
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    fetchImpl: (() => {
      throw new Error('unexpected network use');
    }) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    isTTY: false,
  };
  return { ctx, out, err };
}

const flags = (over: Partial<ScanFlags> = {}): ScanFlags => ({
  json: false,
  noColor: true,
  verbose: false,
  offline: false,
  refresh: false,
  roots: [],
  ...over,
});

test('scan finds skills under default project roots, never touching the network', async () => {
  const t = makeTemp('scan');
  try {
    const cwd = path.join(t, 'proj');
    const home = path.join(t, 'home');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'local-skill', '# one');
    writeSkill(path.join(home, '.claude', 'skills'), 'global-skill', '# two');
    const { ctx, out } = testCtx(cwd, home);
    const code = await runScan(flags(), ctx);
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /local-skill/);
    assert.match(text, /global-skill/);
    assert.match(text, /2 skills found/);
    assert.match(text, /no lockfile/);
  } finally {
    rmTemp(t);
  }
});

test('scan --json emits stable shape with pinnedAs from the lockfile', async () => {
  const t = makeTemp('scanjson');
  try {
    const cwd = path.join(t, 'proj');
    const home = path.join(t, 'home');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'demo', '---\nname: demo\n---\nbody');
    writeLockfile(
      cwd,
      upsertPin(
        emptyLockfile(NOW),
        'acme/skills/demo',
        {
          dir: '.claude/skills/demo',
          pinnedAt: NOW.toISOString(),
          registryHash: null,
          installs: 1,
          snapshot: 'local',
          files: {},
          audits: {},
        },
        NOW,
      ),
    );
    const { ctx, out } = testCtx(cwd, home);
    await runScan(flags({ json: true }), ctx);
    const parsed = JSON.parse(out.join('\n'));
    assert.equal(parsed.command, 'scan');
    assert.equal(parsed.skills.length, 1);
    assert.equal(parsed.skills[0].slug, 'demo');
    assert.equal(parsed.skills[0].name, 'demo');
    assert.equal(parsed.skills[0].pinnedAs, 'acme/skills/demo');
    assert.match(parsed.skills[0].combinedDigest, /^[0-9a-f]{64}$/);
  } finally {
    rmTemp(t);
  }
});

test('explicit missing --root is a usage error, exit 2', async () => {
  const t = makeTemp('scanroot');
  try {
    const { ctx } = testCtx(t, t);
    await assert.rejects(
      runScan(flags({ roots: ['does-not-exist'] }), ctx),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  } finally {
    rmTemp(t);
  }
});
