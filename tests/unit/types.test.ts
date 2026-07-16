import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliError } from '../../src/output/errors.ts';
import {
  parseAudits,
  parseCurated,
  parseErrorBody,
  parseLeaderboard,
  parseSearch,
  parseSkillDetail,
} from '../../src/api/types.ts';
import { loadFixture } from '../helpers.ts';

test('every leaderboard fixture parses', () => {
  for (const f of ['leaderboard-all-time.json', 'leaderboard-trending.json']) {
    const r = parseLeaderboard(loadFixture(f));
    assert.equal(r.data.length, 5);
    assert.equal(r.pagination.hasMore, true);
  }
});

test('hot view carries installsYesterday and change', () => {
  const r = parseLeaderboard(loadFixture('leaderboard-hot.json'));
  assert.equal(typeof r.data[0]!.installsYesterday, 'number');
  assert.equal(typeof r.data[0]!.change, 'number');
});

test('search fixtures parse, including empty results', () => {
  const fuzzy = parseSearch(loadFixture('search-fuzzy.json'));
  assert.equal(fuzzy.searchType, 'fuzzy');
  const semantic = parseSearch(loadFixture('search-semantic.json'));
  assert.equal(semantic.searchType, 'semantic');
  const empty = parseSearch(loadFixture('search-empty.json'));
  assert.deepEqual(empty.data, []);
  assert.equal(empty.count, 0);
});

test('curated fixture parses with owners grouped', () => {
  const r = parseCurated(loadFixture('curated.json'));
  assert.ok(r.totalOwners > 0);
  assert.ok(r.data[0]!.skills.length > 0);
});

test('skill detail with files and hash', () => {
  const d = parseSkillDetail(loadFixture('skill-detail.json'));
  assert.equal(d.id, 'vercel-labs/skills/find-skills');
  assert.match(d.hash!, /^[0-9a-f]{64}$/);
  assert.equal(d.files![0]!.path, 'SKILL.md');
  assert.ok(d.files![0]!.contents.length > 100);
});

test('skill detail with null snapshot', () => {
  const d = parseSkillDetail(loadFixture('skill-detail-nosnapshot.json'));
  assert.equal(d.hash, null);
  assert.equal(d.files, null);
});

test('audit fixtures parse: full pass and mixed', () => {
  const full = parseAudits(loadFixture('audit-results.json'));
  assert.equal(full.audits.length, 5);
  const mixed = parseAudits(loadFixture('audit-mixed.json'));
  assert.deepEqual(
    mixed.audits.map((a) => a.status).sort(),
    ['fail', 'pass', 'warn'],
  );
  assert.equal(mixed.audits[0]!.categories!.length, 1);
});

test('isDuplicate absent stays undefined, never false-positive', () => {
  const r = parseLeaderboard(loadFixture('leaderboard-all-time.json'));
  assert.equal(r.data[0]!.isDuplicate, undefined);
});

test('malformed inputs throw CliError exit 3', () => {
  const bad: unknown[] = [
    null,
    { data: 'nope', pagination: {} },
    { data: [{ slug: 'x' }], pagination: {} }, // missing id
  ];
  for (const b of bad) {
    assert.throws(
      () => parseLeaderboard(b),
      (e: unknown) => e instanceof CliError && e.exitCode === 3,
    );
  }
  assert.throws(
    () => parseSkillDetail({ id: 'a/b/c', source: 'a/b', slug: 'c', files: 'wat' }),
    (e: unknown) => e instanceof CliError,
  );
  assert.throws(
    () => parseAudits({ id: 'x', audits: [{ status: 'meh' }] }),
    (e: unknown) => e instanceof CliError,
  );
});

test('real 401 envelope parses as error body', () => {
  const e = parseErrorBody(loadFixture('error-401.json'));
  assert.equal(e!.error, 'authentication_required');
  assert.equal(parseErrorBody({ nope: 1 }), null);
});
