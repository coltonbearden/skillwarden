import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCache } from '../../src/api/cache.ts';
import { createClient, parseSkillId, type ClientOptions } from '../../src/api/client.ts';
import { CliError } from '../../src/output/errors.ts';
import { fakeSleep, loadFixtureRaw, makeTemp, rmTemp } from '../helpers.ts';

type Scripted = { status: number; body: string; headers?: Record<string, string> };

function fakeFetch(script: Scripted[] | ((url: string) => Scripted)) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const next = typeof script === 'function' ? script(url) : script.shift();
    if (!next) throw new Error(`fakeFetch: no scripted response for ${url}`);
    return new Response(next.body, {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function makeClient(
  dir: string,
  fetchScript: Scripted[] | ((url: string) => Scripted),
  overrides: Partial<ClientOptions> = {},
) {
  const { impl, calls } = fakeFetch(fetchScript);
  const sleeper = fakeSleep();
  const client = createClient({
    baseUrl: 'https://api.test/api/v1',
    token: 'tok',
    cache: openCache(dir, () => {}),
    fetchImpl: impl,
    sleep: sleeper.sleep,
    now: () => new Date('2026-07-15T12:00:00Z'),
    ...overrides,
  });
  return { client, calls, sleeps: sleeper.calls };
}

const ID = parseSkillId('vercel-labs/skills/find-skills');

/** A clock that advances past the throttle window on every read. */
function tickingNow(startIso = '2026-07-15T12:00:00Z', stepMs = 1500): () => Date {
  let t = Date.parse(startIso);
  return () => {
    t += stepMs;
    return new Date(t);
  };
}

test('parseSkillId accepts github and well-known forms, rejects others', () => {
  assert.deepEqual(parseSkillId('a/b/c'), { source: 'a/b', slug: 'c', id: 'a/b/c' });
  assert.deepEqual(parseSkillId('mintlify.com/mintlify'), {
    source: 'mintlify.com',
    slug: 'mintlify',
    id: 'mintlify.com/mintlify',
  });
  for (const bad of ['justone', 'a/b', 'a/b/c/d', '/a/b/c', 'a//c']) {
    assert.throws(
      () => parseSkillId(bad),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
      bad,
    );
  }
});

test('200 responses are cached and reused while fresh', async () => {
  const dir = makeTemp('cl-fresh');
  try {
    const { client, calls } = makeClient(dir, [
      {
        status: 200,
        body: loadFixtureRaw('skill-detail.json'),
        headers: { 'cache-control': 'public, max-age=300' },
      },
    ]);
    const first = await client.skillDetail(ID);
    assert.equal(first.slug, 'find-skills');
    assert.equal(client.servedAge(client.urlFor('/skills/vercel-labs/skills/find-skills')), null);
    const second = await client.skillDetail(ID);
    assert.equal(second.installs, first.installs);
    assert.equal(calls.length, 1, 'second call must come from cache');
  } finally {
    rmTemp(dir);
  }
});

test('refresh mode bypasses a fresh cache', async () => {
  const dir = makeTemp('cl-refresh');
  try {
    const body = loadFixtureRaw('skill-detail.json');
    const first = makeClient(dir, [
      { status: 200, body, headers: { 'cache-control': 'max-age=300' } },
    ]);
    await first.client.skillDetail(ID);
    const second = makeClient(dir, [{ status: 200, body }], { mode: 'refresh' });
    await second.client.skillDetail(ID);
    assert.equal(second.calls.length, 1);
  } finally {
    rmTemp(dir);
  }
});

test('offline mode serves stale entries and reports age; misses throw exit 3', async () => {
  const dir = makeTemp('cl-off');
  try {
    const body = loadFixtureRaw('skill-detail.json');
    const seed = makeClient(dir, [{ status: 200, body, headers: { 'cache-control': 'max-age=1' } }]);
    await seed.client.skillDetail(ID);

    const later = new Date('2026-07-15T13:00:00Z');
    const off = makeClient(dir, [], { mode: 'offline', now: () => later });
    const d = await off.client.skillDetail(ID);
    assert.equal(d.slug, 'find-skills');
    assert.equal(off.client.servedAge(off.client.urlFor('/skills/vercel-labs/skills/find-skills')), 3600);

    await assert.rejects(
      off.client.curated(),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && /--offline/.test(e.message),
    );
  } finally {
    rmTemp(dir);
  }
});

test('429 sleeps Retry-After then retries once; second 429 throws exit 3', async () => {
  const dir = makeTemp('cl-429');
  try {
    const ok = { status: 200, body: loadFixtureRaw('curated.json') };
    const limited = {
      status: 429,
      body: loadFixtureRaw('error-429.json'),
      headers: { 'retry-after': '42' },
    };
    const success = makeClient(dir, [limited, ok], { now: tickingNow() });
    await success.client.curated();
    assert.deepEqual(success.sleeps, [42_000]);

    const failing = makeClient(makeTemp('cl-429b'), [limited, limited], { now: tickingNow() });
    await assert.rejects(
      failing.client.curated(),
      (e: unknown) =>
        e instanceof CliError && e.exitCode === 3 && e.message.includes('Try again in 42s'),
    );
  } finally {
    rmTemp(dir);
  }
});

test('429 without Retry-After uses 30s default; huge values cap at 60s', async () => {
  const ok = { status: 200, body: loadFixtureRaw('curated.json') };
  const noHeader = makeClient(
    makeTemp('cl-ra1'),
    [{ status: 429, body: loadFixtureRaw('error-429.json') }, ok],
    { now: tickingNow() },
  );
  await noHeader.client.curated();
  assert.deepEqual(noHeader.sleeps, [30_000]);

  const huge = makeClient(
    makeTemp('cl-ra2'),
    [{ status: 429, body: loadFixtureRaw('error-429.json'), headers: { 'retry-after': '9999' } }, ok],
    { now: tickingNow() },
  );
  await huge.client.curated();
  assert.deepEqual(huge.sleeps, [60_000]);
});

test('503 backs off 1s/2s/4s then throws exit 3', async () => {
  const err = { status: 503, body: loadFixtureRaw('error-503.json') };
  const { client, sleeps } = makeClient(makeTemp('cl-503'), [err, err, err, err], {
    now: tickingNow(),
  });
  await assert.rejects(
    client.curated(),
    (e: unknown) => e instanceof CliError && e.exitCode === 3 && /Tried 3 times/.test(e.message),
  );
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test('503 recovers when a retry succeeds', async () => {
  const err = { status: 503, body: loadFixtureRaw('error-503.json') };
  const ok = { status: 200, body: loadFixtureRaw('curated.json') };
  const { client, sleeps } = makeClient(makeTemp('cl-503b'), [err, ok], { now: tickingNow() });
  const r = await client.curated();
  assert.ok(r.totalOwners > 0);
  assert.deepEqual(sleeps, [1000]);
});

test('401 maps to authRejected with token, authMissing without', async () => {
  const body = loadFixtureRaw('error-401.json');
  const withTok = makeClient(makeTemp('cl-401a'), [{ status: 401, body }]);
  await assert.rejects(
    withTok.client.curated(),
    (e: unknown) => e instanceof CliError && e.exitCode === 4 && /rejected the token/.test(e.message),
  );
  const noTok = makeClient(makeTemp('cl-401b'), [{ status: 401, body }], { token: undefined });
  await assert.rejects(
    noTok.client.curated(),
    (e: unknown) => e instanceof CliError && e.exitCode === 4 && /Set SKILLS_SH_API_KEY/.test(e.message),
  );
});

test('audit 404 returns the unaudited data state; detail 404 raises NotFound', async () => {
  const nf = { status: 404, body: loadFixtureRaw('error-404-audit.json') };
  const { client } = makeClient(makeTemp('cl-404'), () => nf);
  assert.equal(await client.skillAudits(ID), 'unaudited');
  await assert.rejects(client.skillDetail(ID), (e: unknown) => (e as Error).name === 'NotFoundError');
});

test('400 maps to usage error exit 2 with API message', async () => {
  const { client } = makeClient(makeTemp('cl-400'), [
    { status: 400, body: loadFixtureRaw('error-400.json') },
  ]);
  await assert.rejects(
    client.search('a'),
    (e: unknown) =>
      e instanceof CliError && e.exitCode === 2 && /at least 2 characters/.test(e.message),
  );
});

test('network failure falls back to stale cache with warning, else exit 3', async () => {
  const dir = makeTemp('cl-net');
  try {
    const body = loadFixtureRaw('curated.json');
    const seed = makeClient(dir, [{ status: 200, body, headers: { 'cache-control': 'max-age=1' } }]);
    await seed.client.curated();

    const boom = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    }) as unknown as typeof fetch;
    const notes: string[] = [];
    const later = new Date('2026-07-15T12:10:00Z');
    const stale = createClient({
      baseUrl: 'https://api.test/api/v1',
      token: 'tok',
      cache: openCache(dir, () => {}),
      fetchImpl: boom,
      sleep: fakeSleep().sleep,
      now: () => later,
      stderr: (l) => notes.push(l),
    });
    const r = await stale.curated();
    assert.ok(r.totalOwners > 0);
    assert.match(notes.join('\n'), /using cached response from 600s ago/);

    const cold = createClient({
      baseUrl: 'https://api.test/api/v1',
      token: 'tok',
      cache: openCache(makeTemp('cl-net2'), () => {}),
      fetchImpl: boom,
      sleep: fakeSleep().sleep,
      now: () => later,
    });
    await assert.rejects(
      cold.curated(),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && /Could not reach/.test(e.message),
    );
  } finally {
    rmTemp(dir);
  }
});

test('malformed 200 body throws exit 3', async () => {
  const { client } = makeClient(makeTemp('cl-mal'), [{ status: 200, body: 'not json{' }]);
  await assert.rejects(
    client.curated(),
    (e: unknown) => e instanceof CliError && e.exitCode === 3 && /unparseable/.test(e.message),
  );
});

test('throttle spaces consecutive requests by 1s', async () => {
  const ok = () => ({ status: 200, body: loadFixtureRaw('curated.json') });
  const { client, sleeps } = makeClient(makeTemp('cl-thr'), ok, { mode: 'refresh' });
  await client.curated();
  await client.curated();
  await client.curated();
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('per_page and limit are clamped to documented bounds', async () => {
  const { client, calls } = makeClient(makeTemp('cl-clamp'), (url) => {
    if (url.includes('/skills/search')) {
      return { status: 200, body: loadFixtureRaw('search-fuzzy.json') };
    }
    return { status: 200, body: loadFixtureRaw('leaderboard-all-time.json') };
  });
  await client.leaderboard('all-time', 0, 9999);
  await client.search('commit', 0);
  assert.match(calls[0]!, /per_page=500/);
  assert.match(calls[1]!, /limit=1(?!\d)/);
});
