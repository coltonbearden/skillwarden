import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isFresh, openCache, type CacheEntry } from '../../src/api/cache.ts';
import { makeTemp, rmTemp } from '../helpers.ts';

const URL1 = 'https://skills.sh/api/v1/skills/curated';

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    url: URL1,
    status: 200,
    fetchedAt: '2026-07-15T12:00:00.000Z',
    ttlSeconds: 300,
    body: { hello: 'world' },
    rateLimit: { limit: 600, remaining: 594, reset: 31 },
    ...overrides,
  };
}

test('cache roundtrip', () => {
  const dir = makeTemp('cache');
  try {
    const warnings: string[] = [];
    const c = openCache(dir, (m) => warnings.push(m));
    assert.equal(c.get(URL1), null);
    c.put(URL1, entry());
    assert.deepEqual(c.get(URL1)!.body, { hello: 'world' });
    assert.deepEqual(warnings, []);
  } finally {
    rmTemp(dir);
  }
});

test('freshness respects ttl against the provided clock', () => {
  const e = entry();
  assert.equal(isFresh(e, new Date('2026-07-15T12:04:59Z')), true);
  assert.equal(isFresh(e, new Date('2026-07-15T12:05:01Z')), false);
  assert.equal(isFresh(entry({ ttlSeconds: 0 }), new Date('2026-07-15T12:00:00Z')), false);
});

test('corrupt entry reads as a miss and can be overwritten', () => {
  const dir = makeTemp('corrupt');
  try {
    const c = openCache(dir, () => {});
    c.put(URL1, entry());
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    fs.writeFileSync(path.join(dir, files[0]!), '{not json');
    assert.equal(c.get(URL1), null);
    c.put(URL1, entry({ body: 'second' }));
    assert.equal(c.get(URL1)!.body, 'second');
  } finally {
    rmTemp(dir);
  }
});

test('unwritable cache dir warns once and degrades', () => {
  const dir = makeTemp('ro');
  try {
    const blocking = path.join(dir, 'blocked');
    fs.writeFileSync(blocking, 'a file where the cache dir should be');
    const warnings: string[] = [];
    const c = openCache(blocking, (m) => warnings.push(m));
    c.put(URL1, entry());
    c.put(URL1, entry());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /not writable/);
    assert.equal(c.get(URL1), null);
  } finally {
    rmTemp(dir);
  }
});

test('ageSeconds computes whole seconds', () => {
  const dir = makeTemp('age');
  try {
    const c = openCache(dir, () => {});
    assert.equal(c.ageSeconds(entry(), new Date('2026-07-15T12:01:30Z')), 90);
  } finally {
    rmTemp(dir);
  }
});
