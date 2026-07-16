import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../output/errors.ts';
import type { PinnedAudits } from './audit-model.ts';

export const LOCKFILE_NAME = 'skillwarden.lock.json';

export interface PinnedSkill {
  /** Relative local dir, forward slashes. */
  dir: string;
  pinnedAt: string;
  /** API `hash` verbatim (null = registry had no snapshot). */
  registryHash: string | null;
  installs: number;
  /** Present only when learned from a listing/search response (D-09). */
  isDuplicate?: true;
  /** 'registry' = digests of registry files[]; 'local' = digests of local files at pin time. */
  snapshot: 'registry' | 'local';
  /** posix path -> sha256 of CRLF-normalized contents. */
  files: Record<string, string>;
  audits: PinnedAudits;
}

export interface Lockfile {
  lockfileVersion: 1;
  pinnedAt: string;
  skills: Record<string, PinnedSkill>;
}

export function emptyLockfile(now: Date): Lockfile {
  return { lockfileVersion: 1, pinnedAt: now.toISOString(), skills: {} };
}

function fail(detail: string): never {
  throw new CliError(`Invalid ${LOCKFILE_NAME}: ${detail}`, 2);
}

export function readLockfile(cwd: string): Lockfile | null {
  const file = path.join(cwd, LOCKFILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`not valid JSON (${(e as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('top level is not an object');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o['lockfileVersion'] !== 'number') fail('missing lockfileVersion');
  if (o['lockfileVersion'] > 1) {
    throw new CliError(
      `${LOCKFILE_NAME} has lockfileVersion ${o['lockfileVersion']}, which was created by a ` +
        'newer skillwarden. Upgrade skillwarden to use it.',
      2,
    );
  }
  if (o['lockfileVersion'] !== 1) fail(`unsupported lockfileVersion ${o['lockfileVersion']}`);
  if (typeof o['skills'] !== 'object' || o['skills'] === null) fail('missing skills map');
  const skills: Record<string, PinnedSkill> = {};
  for (const [id, v] of Object.entries(o['skills'] as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) fail(`skill '${id}' entry is not an object`);
    const s = v as Record<string, unknown>;
    if (typeof s['dir'] !== 'string') fail(`skill '${id}' missing dir`);
    if (s['snapshot'] !== 'registry' && s['snapshot'] !== 'local') {
      fail(`skill '${id}' has invalid snapshot kind`);
    }
    if (typeof s['files'] !== 'object' || s['files'] === null) fail(`skill '${id}' missing files`);
    skills[id] = {
      dir: s['dir'],
      pinnedAt: typeof s['pinnedAt'] === 'string' ? s['pinnedAt'] : '',
      registryHash: typeof s['registryHash'] === 'string' ? s['registryHash'] : null,
      installs: typeof s['installs'] === 'number' ? s['installs'] : 0,
      ...(s['isDuplicate'] === true ? { isDuplicate: true as const } : {}),
      snapshot: s['snapshot'],
      files: Object.fromEntries(
        Object.entries(s['files'] as Record<string, unknown>).filter(
          ([, hex]) => typeof hex === 'string',
        ),
      ) as Record<string, string>,
      audits:
        typeof s['audits'] === 'object' && s['audits'] !== null
          ? (s['audits'] as PinnedAudits)
          : {},
    };
  }
  return { lockfileVersion: 1, pinnedAt: String(o['pinnedAt'] ?? ''), skills };
}

/** Deep sort object keys so serialization is deterministic and diff-friendly. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortDeep(val)]),
    );
  }
  return v;
}

export function writeLockfile(cwd: string, lf: Lockfile): void {
  const file = path.join(cwd, LOCKFILE_NAME);
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(
    {
      lockfileVersion: lf.lockfileVersion,
      pinnedAt: lf.pinnedAt,
      skills: sortDeep(lf.skills),
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function upsertPin(lf: Lockfile, id: string, pin: PinnedSkill, now: Date): Lockfile {
  return {
    ...lf,
    pinnedAt: now.toISOString(),
    skills: { ...lf.skills, [id]: pin },
  };
}
