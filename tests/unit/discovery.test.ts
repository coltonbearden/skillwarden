import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  combineDigests,
  defaultRoots,
  digestContent,
  discoverSkills,
  fingerprintDir,
  parseFrontmatter,
} from '../../src/core/discovery.ts';
import { linkDir, makeTemp, rmTemp, writeSkill } from '../helpers.ts';

test('defaultRoots covers project and global agent dirs', () => {
  const roots = defaultRoots('/proj', '/home/u');
  assert.ok(roots.includes(path.join('/proj', '.claude', 'skills')));
  assert.ok(roots.includes(path.join('/proj', '.agents', 'skills')));
  assert.ok(roots.includes(path.join('/proj', 'skills')));
  assert.ok(roots.includes(path.join('/home/u', '.claude', 'skills')));
  assert.equal(roots.length, 9);
});

test('discoverSkills finds skills, ignores non-skill dirs and files', async () => {
  const t = makeTemp('disc');
  try {
    writeSkill(t, 'alpha', '---\nname: alpha\ndescription: does things\n---\n# Alpha\n');
    writeSkill(t, 'beta', '# no frontmatter\n', { 'ref/extra.md': 'more' });
    // non-skill noise
    await import('node:fs').then((fs) => {
      fs.default.mkdirSync(path.join(t, 'not-a-skill'));
      fs.default.writeFileSync(path.join(t, 'loose-file.md'), 'x');
    });
    const skills = await discoverSkills([t]);
    assert.deepEqual(
      skills.map((s) => s.slug),
      ['alpha', 'beta'],
    );
    assert.equal(skills[0]!.frontmatter.name, 'alpha');
    assert.equal(skills[0]!.frontmatter.description, 'does things');
    assert.deepEqual(skills[1]!.frontmatter, {});
    assert.deepEqual(Object.keys(skills[1]!.fingerprint.files).sort(), [
      'SKILL.md',
      'ref/extra.md',
    ]);
  } finally {
    rmTemp(t);
  }
});

test('CRLF and LF content produce identical digests', () => {
  assert.equal(digestContent('a\r\nb\r\n'), digestContent('a\nb\n'));
  assert.notEqual(digestContent('a\nb\n'), digestContent('a\nb'));
});

test('fingerprint skips .git and node_modules', async () => {
  const t = makeTemp('excl');
  try {
    const dir = writeSkill(t, 's', 'hi', {
      '.git/config': 'x',
      'node_modules/pkg/index.js': 'y',
      'kept.md': 'z',
    });
    const { fingerprint } = await fingerprintDir(dir);
    assert.deepEqual(Object.keys(fingerprint.files).sort(), ['SKILL.md', 'kept.md']);
  } finally {
    rmTemp(t);
  }
});

test('combined digest is order-independent and path-sensitive', () => {
  const a = combineDigests({ 'a.md': '11', 'b.md': '22' });
  const b = combineDigests({ 'b.md': '22', 'a.md': '11' });
  assert.equal(a, b);
  assert.notEqual(a, combineDigests({ 'a.md': '11', 'c.md': '22' }));
});

test('symlinked duplicate collapses into aliases', async () => {
  const t = makeTemp('link');
  try {
    const rootA = path.join(t, 'rootA');
    const rootB = path.join(t, 'rootB');
    const real = writeSkill(rootA, 'shared', '# shared\n');
    linkDir(real, path.join(rootB, 'shared'));
    const skills = await discoverSkills([rootA, rootB]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.aliases.length, 1);
  } finally {
    rmTemp(t);
  }
});

test('same slug in two roots without links stays two entries', async () => {
  const t = makeTemp('dupslug');
  try {
    writeSkill(path.join(t, 'r1'), 'dup', 'one');
    writeSkill(path.join(t, 'r2'), 'dup', 'two');
    const skills = await discoverSkills([path.join(t, 'r1'), path.join(t, 'r2')]);
    assert.equal(skills.length, 2);
  } finally {
    rmTemp(t);
  }
});

test('nonexistent roots are skipped silently', async () => {
  const skills = await discoverSkills([path.join(makeTemp('gone'), 'nope')]);
  assert.deepEqual(skills, []);
});

test('parseFrontmatter handles BOM, quotes, and absence', () => {
  assert.deepEqual(parseFrontmatter('﻿---\nname: "x"\n---\nbody'), { name: 'x' });
  assert.deepEqual(parseFrontmatter('# just markdown'), {});
  assert.deepEqual(parseFrontmatter('---\r\nname: win\r\n---\r\nbody'), { name: 'win' });
});
