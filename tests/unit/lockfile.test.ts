import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../src/output/errors.ts';
import {
  emptyLockfile,
  LOCKFILE_NAME,
  readLockfile,
  upsertPin,
  writeLockfile,
  type PinnedSkill,
} from '../../src/core/lockfile.ts';
import { makeTemp, rmTemp } from '../helpers.ts';

const NOW = new Date('2026-07-15T18:00:00Z');

function somePin(): PinnedSkill {
  return {
    dir: '.claude/skills/demo',
    pinnedAt: NOW.toISOString(),
    registryHash: 'ab'.repeat(32),
    installs: 42,
    snapshot: 'registry',
    files: { 'SKILL.md': 'cd'.repeat(32) },
    audits: { socket: { status: 'pass', riskLevel: 'NONE', auditedAt: '2026-07-14T00:00:00Z' } },
  };
}

test('missing lockfile reads as null', () => {
  const t = makeTemp('lf-none');
  try {
    assert.equal(readLockfile(t), null);
  } finally {
    rmTemp(t);
  }
});

test('write/read roundtrip preserves content; rewrite is byte-stable', () => {
  const t = makeTemp('lf-rt');
  try {
    const lf = upsertPin(emptyLockfile(NOW), 'a/b/demo', somePin(), NOW);
    writeLockfile(t, lf);
    const first = fs.readFileSync(path.join(t, LOCKFILE_NAME), 'utf-8');
    const read = readLockfile(t)!;
    assert.deepEqual(read.skills['a/b/demo'], somePin());
    writeLockfile(t, read);
    const second = fs.readFileSync(path.join(t, LOCKFILE_NAME), 'utf-8');
    assert.equal(first, second);
    assert.ok(first.endsWith('\n'));
  } finally {
    rmTemp(t);
  }
});

test('keys are sorted regardless of insertion order', () => {
  const t = makeTemp('lf-sort');
  try {
    let lf = emptyLockfile(NOW);
    lf = upsertPin(lf, 'z/z/zeta', somePin(), NOW);
    lf = upsertPin(lf, 'a/a/alpha', somePin(), NOW);
    writeLockfile(t, lf);
    const raw = fs.readFileSync(path.join(t, LOCKFILE_NAME), 'utf-8');
    assert.ok(raw.indexOf('a/a/alpha') < raw.indexOf('z/z/zeta'));
  } finally {
    rmTemp(t);
  }
});

test('future lockfileVersion is refused with upgrade guidance', () => {
  const t = makeTemp('lf-future');
  try {
    fs.writeFileSync(
      path.join(t, LOCKFILE_NAME),
      JSON.stringify({ lockfileVersion: 2, pinnedAt: '', skills: {} }),
    );
    assert.throws(
      () => readLockfile(t),
      (e: unknown) => e instanceof CliError && e.exitCode === 2 && /newer skillwarden/.test(e.message),
    );
  } finally {
    rmTemp(t);
  }
});

test('invalid JSON and invalid shapes produce exit-2 errors naming the problem', () => {
  const t = makeTemp('lf-bad');
  try {
    fs.writeFileSync(path.join(t, LOCKFILE_NAME), '{broken');
    assert.throws(
      () => readLockfile(t),
      (e: unknown) => e instanceof CliError && /not valid JSON/.test(e.message),
    );
    fs.writeFileSync(
      path.join(t, LOCKFILE_NAME),
      JSON.stringify({ lockfileVersion: 1, skills: { 'a/b/c': { snapshot: 'nope' } } }),
    );
    assert.throws(
      () => readLockfile(t),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  } finally {
    rmTemp(t);
  }
});
