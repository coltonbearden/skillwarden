import {
  authMissing,
  authRejected,
  badRequest,
  malformed,
  network,
  NotFoundError,
  offlineMiss,
  rateLimited,
  unavailable503,
  usage,
} from '../output/errors.ts';
import { isFresh, type Cache, type RateLimitInfo } from './cache.ts';
import {
  parseAudits,
  parseCurated,
  parseErrorBody,
  parseLeaderboard,
  parseSearch,
  parseSkillDetail,
  type AuditResponse,
  type CuratedResponse,
  type LeaderboardResponse,
  type SearchResponse,
  type SkillDetail,
} from './types.ts';
import { VERSION } from '../version.ts';

export const DEFAULT_BASE_URL = 'https://skills.sh/api/v1';

const TIMEOUT_MS = 10_000;
const THROTTLE_MS = 1_000;
const RETRY_AFTER_DEFAULT_S = 30;
const RETRY_AFTER_CAP_S = 60;
const BACKOFF_503_MS = [1_000, 2_000, 4_000];

export interface SkillId {
  source: string;
  slug: string;
  id: string;
}

/**
 * Parse `{source}/{slug}`: GitHub ids have 3 path segments (owner/repo/slug),
 * well-known ids have 2 (domain.com/slug).
 */
export function parseSkillId(raw: string): SkillId {
  const parts = raw.split('/').filter((p) => p !== '');
  if (parts.length === 3 && parts.join('/') === raw) {
    return { source: `${parts[0]}/${parts[1]}`, slug: parts[2]!, id: raw };
  }
  if (parts.length === 2 && parts.join('/') === raw && parts[0]!.includes('.')) {
    return { source: parts[0]!, slug: parts[1]!, id: raw };
  }
  throw usage(
    `Invalid skill id '${raw}'. Expected 'owner/repo/slug' (GitHub) or 'domain.com/slug' (well-known).`,
  );
}

export type ClientMode = 'online' | 'offline' | 'refresh';

export interface ClientOptions {
  baseUrl?: string;
  token?: string | undefined;
  cache: Cache;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  mode?: ClientMode;
  verbose?: boolean;
  stderr?: (line: string) => void;
}

export interface Client {
  leaderboard(
    view: 'all-time' | 'trending' | 'hot',
    page?: number,
    perPage?: number,
  ): Promise<LeaderboardResponse>;
  search(q: string, limit?: number): Promise<SearchResponse>;
  curated(): Promise<CuratedResponse>;
  skillDetail(id: SkillId): Promise<SkillDetail>;
  /** 404 on the audit route is a data state, not an error. */
  skillAudits(id: SkillId): Promise<AuditResponse | 'unaudited'>;
  /** Cache age (seconds) of the response served for this URL in this run; null = live. */
  servedAge(url: string): number | null;
  urlFor(path: string): string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function rateLimitFromHeaders(h: Headers): RateLimitInfo | null {
  const num = (name: string) => {
    const raw = h.get(name);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const info = {
    limit: num('X-RateLimit-Limit'),
    remaining: num('X-RateLimit-Remaining'),
    reset: num('X-RateLimit-Reset'),
  };
  return info.limit === null && info.remaining === null && info.reset === null ? null : info;
}

function ttlFromHeaders(h: Headers): number {
  const cc = h.get('Cache-Control') ?? '';
  const m = /max-age=(\d+)/.exec(cc);
  if (!m) return 60;
  return Number(m[1]);
}

export function createClient(opts: ClientOptions): Client {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const mode = opts.mode ?? 'online';
  const stderr = opts.stderr ?? (() => {});
  const verbose = opts.verbose ?? false;

  const servedAges = new Map<string, number | null>();
  let throttleChain: Promise<void> = Promise.resolve();
  let lastRequestAt = 0;

  function throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = throttleChain.then(async () => {
      const wait = lastRequestAt + THROTTLE_MS - now().getTime();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now().getTime();
    });
    throttleChain = run.catch(() => {});
    return run.then(task);
  }

  async function attemptFetch(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': `skillwarden/${VERSION}`,
    };
    if (opts.token !== undefined && opts.token !== '') {
      headers['authorization'] = `Bearer ${opts.token}`;
    }
    return fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  }

  function staleFallback(url: string, detail: string): unknown {
    const entry = opts.cache.get(url);
    if (entry !== null) {
      const age = opts.cache.ageSeconds(entry, now());
      servedAges.set(url, age);
      stderr(
        `skillwarden: skills.sh unreachable (${detail}); using cached response from ${age}s ago.`,
      );
      return entry.body;
    }
    throw network(detail);
  }

  async function requestJson(url: string, resource: string): Promise<unknown> {
    // 1. cache consultation
    const entry = opts.cache.get(url);
    if (mode === 'offline') {
      if (entry === null) throw offlineMiss(resource);
      servedAges.set(url, opts.cache.ageSeconds(entry, now()));
      return entry.body;
    }
    if (mode !== 'refresh' && entry !== null && isFresh(entry, now())) {
      servedAges.set(url, opts.cache.ageSeconds(entry, now()));
      return entry.body;
    }

    // 2. network, throttled; 429 retried once, 503 retried x3
    let retried429 = false;
    let attempts503 = 0;
    for (;;) {
      let res: Response;
      try {
        res = await throttled(() => attemptFetch(url));
      } catch (e) {
        const detail =
          e instanceof Error && e.name === 'TimeoutError'
            ? 'timeout after 10s'
            : e instanceof Error
              ? ((e.cause as Error | undefined)?.message ?? e.message)
              : String(e);
        return staleFallback(url, detail);
      }

      if (res.status === 200) {
        let body: unknown;
        try {
          body = await res.json();
        } catch (e) {
          throw malformed((e as Error).message);
        }
        const rl = rateLimitFromHeaders(res.headers);
        if (verbose && rl !== null) {
          stderr(`skillwarden: rate limit ${rl.remaining ?? '?'}/${rl.limit ?? '?'} remaining`);
        }
        opts.cache.put(url, {
          url,
          status: 200,
          fetchedAt: now().toISOString(),
          ttlSeconds: ttlFromHeaders(res.headers),
          body,
          rateLimit: rl,
        });
        servedAges.set(url, null);
        return body;
      }

      const errBody = parseErrorBody(await res.json().catch(() => null));
      switch (res.status) {
        case 400:
          throw badRequest(errBody?.message ?? 'invalid parameters');
        case 401:
          throw opts.token !== undefined && opts.token !== '' ? authRejected() : authMissing();
        case 404:
          throw new NotFoundError(url);
        case 429: {
          const raw = Number(res.headers.get('Retry-After'));
          const retryAfter = clamp(
            Number.isFinite(raw) && raw > 0 ? raw : RETRY_AFTER_DEFAULT_S,
            1,
            RETRY_AFTER_CAP_S,
          );
          if (retried429) throw rateLimited(retryAfter);
          retried429 = true;
          if (verbose) stderr(`skillwarden: 429, waiting ${retryAfter}s before one retry`);
          await sleep(retryAfter * 1000);
          continue;
        }
        case 503: {
          if (attempts503 >= BACKOFF_503_MS.length) throw unavailable503();
          const wait = BACKOFF_503_MS[attempts503]!;
          attempts503 += 1;
          if (verbose) stderr(`skillwarden: 503, backing off ${wait}ms (attempt ${attempts503})`);
          await sleep(wait);
          continue;
        }
        default:
          throw malformed(`unexpected HTTP ${res.status}`);
      }
    }
  }

  const q = (params: Record<string, string | number>) =>
    new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();

  return {
    urlFor: (p: string) => `${baseUrl}${p}`,
    servedAge: (url: string) => servedAges.get(url) ?? null,

    async leaderboard(view, page = 0, perPage = 100) {
      const url = `${baseUrl}/skills?${q({ view, page, per_page: clamp(perPage, 1, 500) })}`;
      return parseLeaderboard(await requestJson(url, `leaderboard (${view})`));
    },

    async search(query, limit = 50) {
      const url = `${baseUrl}/skills/search?${q({ q: query, limit: clamp(limit, 1, 200) })}`;
      return parseSearch(await requestJson(url, `search '${query}'`));
    },

    async curated() {
      const url = `${baseUrl}/skills/curated`;
      return parseCurated(await requestJson(url, 'curated set'));
    },

    async skillDetail(id) {
      const url = `${baseUrl}/skills/${id.source}/${id.slug}`;
      return parseSkillDetail(await requestJson(url, `skill '${id.id}'`));
    },

    async skillAudits(id) {
      const url = `${baseUrl}/skills/audit/${id.source}/${id.slug}`;
      try {
        return parseAudits(await requestJson(url, `audits for '${id.id}'`));
      } catch (e) {
        if (e instanceof NotFoundError) return 'unaudited';
        throw e;
      }
    },
  };
}
