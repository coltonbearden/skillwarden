import { malformed } from '../output/errors.ts';

export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: 'github' | 'well-known' | string;
  installUrl: string | null;
  url: string;
  /** true = detected fork/copy; undefined = unknown (flag absent). */
  isDuplicate: true | undefined;
  /** hot view only */
  installsYesterday?: number;
  change?: number;
}

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}

export interface LeaderboardResponse {
  data: SkillSummary[];
  pagination: Pagination;
}

export interface SearchResponse {
  data: SkillSummary[];
  query: string;
  searchType: string;
  count: number;
  durationMs: number;
}

export interface CuratedOwner {
  owner: string;
  totalInstalls: number;
  featuredRepo: string;
  featuredSkill: string;
  skills: SkillSummary[];
}

export interface CuratedResponse {
  data: CuratedOwner[];
  totalOwners: number;
  totalSkills: number;
  generatedAt: string;
}

export interface SkillFile {
  path: string;
  contents: string;
}

export interface SkillDetail {
  id: string;
  source: string;
  slug: string;
  installs: number;
  hash: string | null;
  files: SkillFile[] | null;
}

export type AuditStatus = 'pass' | 'warn' | 'fail';

export interface AuditEntry {
  provider: string;
  slug: string;
  status: AuditStatus;
  summary: string;
  auditedAt: string;
  riskLevel?: string;
  categories?: string[];
}

export interface AuditResponse {
  id: string;
  source: string;
  slug: string;
  audits: AuditEntry[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Structural validators. Lenient to extra fields; strict on what we consume.
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function req<T>(cond: boolean, value: T, where: string): T {
  if (!cond) throw malformed(where);
  return value;
}

function parseSkillSummary(v: unknown, where: string): SkillSummary {
  req(isObj(v), v, `${where}: skill entry is not an object`);
  const o = v as Record<string, unknown>;
  const id = req(typeof o['id'] === 'string', o['id'] as string, `${where}: missing id`);
  const installs = req(
    typeof o['installs'] === 'number',
    o['installs'] as number,
    `${where}: '${id}' installs is not a number`,
  );
  return {
    id,
    slug: typeof o['slug'] === 'string' ? o['slug'] : id.split('/').pop()!,
    name: typeof o['name'] === 'string' ? o['name'] : id.split('/').pop()!,
    source: req(
      typeof o['source'] === 'string',
      o['source'] as string,
      `${where}: '${id}' missing source`,
    ),
    installs,
    sourceType: typeof o['sourceType'] === 'string' ? o['sourceType'] : 'github',
    installUrl: typeof o['installUrl'] === 'string' ? o['installUrl'] : null,
    url: typeof o['url'] === 'string' ? o['url'] : `https://skills.sh/${id}`,
    isDuplicate: o['isDuplicate'] === true ? true : undefined,
    ...(typeof o['installsYesterday'] === 'number'
      ? { installsYesterday: o['installsYesterday'] }
      : {}),
    ...(typeof o['change'] === 'number' ? { change: o['change'] } : {}),
  };
}

export function parseLeaderboard(v: unknown): LeaderboardResponse {
  req(isObj(v), v, 'leaderboard: not an object');
  const o = v as Record<string, unknown>;
  req(Array.isArray(o['data']), o, 'leaderboard: data is not an array');
  const p = o['pagination'];
  req(isObj(p), p, 'leaderboard: missing pagination');
  const pg = p as Record<string, unknown>;
  return {
    data: (o['data'] as unknown[]).map((s, i) => parseSkillSummary(s, `leaderboard[${i}]`)),
    pagination: {
      page: typeof pg['page'] === 'number' ? pg['page'] : 0,
      perPage: typeof pg['perPage'] === 'number' ? pg['perPage'] : 0,
      total: typeof pg['total'] === 'number' ? pg['total'] : 0,
      hasMore: pg['hasMore'] === true,
    },
  };
}

export function parseSearch(v: unknown): SearchResponse {
  req(isObj(v), v, 'search: not an object');
  const o = v as Record<string, unknown>;
  req(Array.isArray(o['data']), o, 'search: data is not an array');
  return {
    data: (o['data'] as unknown[]).map((s, i) => parseSkillSummary(s, `search[${i}]`)),
    query: typeof o['query'] === 'string' ? o['query'] : '',
    searchType: typeof o['searchType'] === 'string' ? o['searchType'] : 'unknown',
    count: typeof o['count'] === 'number' ? o['count'] : (o['data'] as unknown[]).length,
    durationMs: typeof o['durationMs'] === 'number' ? o['durationMs'] : 0,
  };
}

export function parseCurated(v: unknown): CuratedResponse {
  req(isObj(v), v, 'curated: not an object');
  const o = v as Record<string, unknown>;
  req(Array.isArray(o['data']), o, 'curated: data is not an array');
  const data = (o['data'] as unknown[]).map((e, i) => {
    req(isObj(e), e, `curated[${i}]: not an object`);
    const c = e as Record<string, unknown>;
    const owner = req(
      typeof c['owner'] === 'string',
      c['owner'] as string,
      `curated[${i}]: missing owner`,
    );
    req(Array.isArray(c['skills']), c, `curated[${i}]: skills is not an array`);
    return {
      owner,
      totalInstalls: typeof c['totalInstalls'] === 'number' ? c['totalInstalls'] : 0,
      featuredRepo: typeof c['featuredRepo'] === 'string' ? c['featuredRepo'] : '',
      featuredSkill: typeof c['featuredSkill'] === 'string' ? c['featuredSkill'] : '',
      skills: (c['skills'] as unknown[]).map((s, j) =>
        parseSkillSummary(s, `curated[${i}].skills[${j}]`),
      ),
    };
  });
  return {
    data,
    totalOwners: typeof o['totalOwners'] === 'number' ? o['totalOwners'] : data.length,
    totalSkills: typeof o['totalSkills'] === 'number' ? o['totalSkills'] : 0,
    generatedAt: typeof o['generatedAt'] === 'string' ? o['generatedAt'] : '',
  };
}

export function parseSkillDetail(v: unknown): SkillDetail {
  req(isObj(v), v, 'skill detail: not an object');
  const o = v as Record<string, unknown>;
  const id = req(typeof o['id'] === 'string', o['id'] as string, 'skill detail: missing id');
  let files: SkillFile[] | null = null;
  if (Array.isArray(o['files'])) {
    files = (o['files'] as unknown[]).map((f, i) => {
      req(isObj(f), f, `skill detail '${id}': files[${i}] is not an object`);
      const ff = f as Record<string, unknown>;
      return {
        path: req(
          typeof ff['path'] === 'string',
          ff['path'] as string,
          `skill detail '${id}': files[${i}] missing path`,
        ),
        contents: req(
          typeof ff['contents'] === 'string',
          ff['contents'] as string,
          `skill detail '${id}': files[${i}] missing contents`,
        ),
      };
    });
  } else {
    req(o['files'] === null || o['files'] === undefined, o, `skill detail '${id}': bad files`);
  }
  return {
    id,
    source: req(
      typeof o['source'] === 'string',
      o['source'] as string,
      `skill detail '${id}': missing source`,
    ),
    slug: req(
      typeof o['slug'] === 'string',
      o['slug'] as string,
      `skill detail '${id}': missing slug`,
    ),
    installs: typeof o['installs'] === 'number' ? o['installs'] : 0,
    hash: typeof o['hash'] === 'string' ? o['hash'] : null,
    files,
  };
}

const AUDIT_STATUSES = new Set<string>(['pass', 'warn', 'fail']);

export function parseAudits(v: unknown): AuditResponse {
  req(isObj(v), v, 'audits: not an object');
  const o = v as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : '';
  req(Array.isArray(o['audits']), o, `audits '${id}': audits is not an array`);
  const audits = (o['audits'] as unknown[]).map((a, i) => {
    req(isObj(a), a, `audits '${id}': entry[${i}] is not an object`);
    const e = a as Record<string, unknown>;
    const status = req(
      typeof e['status'] === 'string' && AUDIT_STATUSES.has(e['status']),
      e['status'] as AuditStatus,
      `audits '${id}': entry[${i}] has unknown status '${String(e['status'])}'`,
    );
    return {
      provider: typeof e['provider'] === 'string' ? e['provider'] : `partner-${i}`,
      slug: typeof e['slug'] === 'string' ? e['slug'] : `partner-${i}`,
      status,
      summary: typeof e['summary'] === 'string' ? e['summary'] : '',
      auditedAt: typeof e['auditedAt'] === 'string' ? e['auditedAt'] : '',
      ...(typeof e['riskLevel'] === 'string' ? { riskLevel: e['riskLevel'] } : {}),
      ...(Array.isArray(e['categories'])
        ? { categories: (e['categories'] as unknown[]).map(String) }
        : {}),
    };
  });
  return {
    id,
    source: typeof o['source'] === 'string' ? o['source'] : '',
    slug: typeof o['slug'] === 'string' ? o['slug'] : '',
    audits,
  };
}

/** Best-effort parse of the error envelope; returns null when it isn't one. */
export function parseErrorBody(v: unknown): ApiErrorBody | null {
  if (!isObj(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['error'] === 'string' && typeof o['message'] === 'string') {
    return { error: o['error'], message: o['message'] };
  }
  return null;
}
