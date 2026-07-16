import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../src/main.ts';
import { VERSION } from '../../src/version.ts';
import { makeTemp, rmTemp } from '../helpers.ts';
import type { CommandContext } from '../../src/context.ts';

function makeCtx(base: string) {
  const cwd = path.join(base, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd,
    home: path.join(base, 'home'),
    env: { SKILLWARDEN_CACHE_DIR: path.join(base, 'cache') },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    fetchImpl: (async () => {
      throw new Error('no network in main tests');
    }) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    now: () => new Date('2026-07-15T18:00:00Z'),
    isTTY: false,
  };
  return { ctx, out, err };
}

test('--version prints the version, exit 0', async () => {
  const t = makeTemp('main-v');
  try {
    const { ctx, out } = makeCtx(t);
    assert.equal(await main(['--version'], ctx), 0);
    assert.deepEqual(out, [VERSION]);
  } finally {
    rmTemp(t);
  }
});

test('root help lists all four commands; bare invocation matches', async () => {
  const t = makeTemp('main-h');
  try {
    const { ctx, out } = makeCtx(t);
    assert.equal(await main(['--help'], ctx), 0);
    const text = out.join('\n');
    for (const cmd of ['scan', 'pin', 'check', 'audit'])
      assert.match(text, new RegExp(`\\b${cmd}\\b`));
    out.length = 0;
    assert.equal(await main([], ctx), 0);
    assert.equal(out.join('\n'), text);
  } finally {
    rmTemp(t);
  }
});

test('each command has its own --help', async () => {
  const t = makeTemp('main-ch');
  try {
    for (const cmd of ['scan', 'pin', 'check', 'audit']) {
      const { ctx, out } = makeCtx(t);
      assert.equal(await main([cmd, '--help'], ctx), 0);
      assert.match(out.join('\n'), new RegExp(`Usage: skillwarden ${cmd}`));
    }
  } finally {
    rmTemp(t);
  }
});

test('unknown command and unknown flags exit 2 with usage on stderr', async () => {
  const t = makeTemp('main-bad');
  try {
    const cases = [['frobnicate'], ['scan', '--bogus'], ['check', 'positional'], ['audit']];
    for (const argv of cases) {
      const { ctx, err } = makeCtx(t);
      assert.equal(await main(argv, ctx), 2, argv.join(' '));
      assert.match(err.join('\n'), /skillwarden --help/);
    }
  } finally {
    rmTemp(t);
  }
});

test('scan rejects --offline/--refresh explicitly', async () => {
  const t = makeTemp('main-scanoff');
  try {
    const { ctx, err } = makeCtx(t);
    assert.equal(await main(['scan', '--offline'], ctx), 2);
    assert.match(err.join('\n'), /always offline/);
  } finally {
    rmTemp(t);
  }
});

test('CliError from a command surfaces its message and exit code', async () => {
  const t = makeTemp('main-clierr');
  try {
    const { ctx, err } = makeCtx(t);
    assert.equal(await main(['check'], ctx), 2);
    assert.match(err.join('\n'), /No skillwarden\.lock\.json here\./);
  } finally {
    rmTemp(t);
  }
});

test('scan runs end-to-end through main and emits json', async () => {
  const t = makeTemp('main-scan');
  try {
    const { ctx, out } = makeCtx(t);
    fs.mkdirSync(path.join(ctx.cwd, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(ctx.cwd, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo');
    assert.equal(await main(['scan', '--json'], ctx), 0);
    const parsed = JSON.parse(out.join('\n'));
    assert.equal(parsed.skills[0].slug, 'demo');
  } finally {
    rmTemp(t);
  }
});
