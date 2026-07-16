import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
}

export interface CacheEntry {
  url: string;
  status: 200;
  fetchedAt: string;
  ttlSeconds: number;
  body: unknown;
  rateLimit: RateLimitInfo | null;
}

export interface Cache {
  get(url: string): CacheEntry | null;
  put(url: string, entry: CacheEntry): void;
  /** Every readable entry (corrupt files skipped). Used for opportunistic lookups. */
  list(): CacheEntry[];
  /** Age of an entry in whole seconds relative to `now`. */
  ageSeconds(entry: CacheEntry, now: Date): number;
}

export function isFresh(entry: CacheEntry, now: Date): boolean {
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched)) return false;
  return fetched + entry.ttlSeconds * 1000 > now.getTime();
}

function entryFile(dir: string, url: string): string {
  return path.join(dir, `${createHash('sha256').update(url).digest('hex')}.json`);
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['url'] === 'string' &&
    o['status'] === 200 &&
    typeof o['fetchedAt'] === 'string' &&
    typeof o['ttlSeconds'] === 'number' &&
    'body' in o
  );
}

/**
 * Open (lazily create) the response cache at `dir`. Corrupt entries read as misses;
 * an unwritable directory degrades to read-only after a single warning.
 */
export function openCache(dir: string, warn: (msg: string) => void): Cache {
  let writable = true;
  return {
    get(url) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(entryFile(dir, url), 'utf-8'));
        return isCacheEntry(parsed) && parsed.url === url ? parsed : null;
      } catch {
        return null;
      }
    },
    put(url, entry) {
      if (!writable) return;
      const file = entryFile(dir, url);
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(entry));
        fs.renameSync(tmp, file);
      } catch (e) {
        writable = false;
        warn(`skillwarden: response cache is not writable (${(e as Error).message}); continuing without caching.`);
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best effort */
        }
      }
    },
    list() {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch {
        return [];
      }
      const out: CacheEntry[] = [];
      for (const n of names) {
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8'));
          if (isCacheEntry(parsed)) out.push(parsed);
        } catch {
          // corrupt entry: skip
        }
      }
      return out;
    },
    ageSeconds(entry, now) {
      const fetched = Date.parse(entry.fetchedAt);
      if (Number.isNaN(fetched)) return Number.MAX_SAFE_INTEGER;
      return Math.max(0, Math.floor((now.getTime() - fetched) / 1000));
    },
  };
}
