import fs from 'node:fs';
import path from 'node:path';
import { parseSkillId, type SkillId } from '../api/client.ts';
import type { Cache } from '../api/cache.ts';
import type { SkillDetail } from '../api/types.ts';
import { modelAudits, toPinnedAudits } from '../core/audit-model.ts';
import { digestContent, discoverSkills, defaultRoots, fingerprintDir } from '../core/discovery.ts';
import {
  emptyLockfile,
  readLockfile,
  upsertPin,
  writeLockfile,
  type PinnedSkill,
} from '../core/lockfile.ts';
import { CliError, NotFoundError, skillNotFound, usage } from '../output/errors.ts';
import { toJsonString } from '../output/format.ts';
import { toPosixRelative } from '../util/paths.ts';
import { buildApi, colorsFor, type CommandContext, type GlobalFlags } from '../context.ts';
import { VERSION } from '../version.ts';

export interface PinFlags extends GlobalFlags {
  all: boolean;
  dir?: string | undefined;
}

/** Opportunistic isDuplicate lookup across cached listing/search bodies (D-09). */
export function duplicateFlagFromCache(cache: Cache, id: string): true | undefined {
  for (const entry of cache.list()) {
    const body = entry.body as { data?: unknown } | null;
    if (typeof body !== 'object' || body === null || !Array.isArray(body.data)) continue;
    const flat: unknown[] = body.data.flatMap((d) => {
      const owner = d as { skills?: unknown };
      return Array.isArray(owner.skills) ? owner.skills : [d];
    });
    for (const s of flat) {
      const sk = s as { id?: unknown; isDuplicate?: unknown };
      if (sk.id === id && sk.isDuplicate === true) return true;
    }
  }
  return undefined;
}

function resolveLocalDir(
  id: SkillId,
  ctx: CommandContext,
  explicitDir: string | undefined,
  lockDirs: Record<string, string>,
  discovered: { slug: string; dir: string }[],
): string {
  if (explicitDir !== undefined) {
    const abs = path.resolve(ctx.cwd, explicitDir);
    if (!fs.existsSync(path.join(abs, 'SKILL.md'))) {
      throw usage(`--dir '${explicitDir}' is not a skill directory (no SKILL.md).`);
    }
    return abs;
  }
  const fromLock = lockDirs[id.id];
  if (fromLock !== undefined) {
    const abs = path.resolve(ctx.cwd, fromLock);
    if (fs.existsSync(path.join(abs, 'SKILL.md'))) return abs;
  }
  const matches = discovered.filter((s) => s.slug === id.slug);
  if (matches.length === 1) return matches[0]!.dir;
  if (matches.length === 0) {
    throw new CliError(
      `Skill '${id.id}': no local directory named '${id.slug}' found. ` +
        `Install it first (npx skills add) or point at it with --dir.`,
      1,
    );
  }
  throw usage(
    `Skill '${id.id}': multiple local directories named '${id.slug}': ` +
      `${matches.map((m) => m.dir).join(', ')}. Disambiguate with --dir.`,
  );
}

async function pinFiles(
  detail: SkillDetail,
  localDir: string,
): Promise<Pick<PinnedSkill, 'snapshot' | 'files'>> {
  if (detail.files !== null) {
    const files: Record<string, string> = {};
    for (const f of detail.files) files[f.path] = digestContent(f.contents);
    return { snapshot: 'registry', files };
  }
  const { fingerprint } = await fingerprintDir(localDir);
  return { snapshot: 'local', files: fingerprint.files };
}

interface PinResult {
  id: string;
  status: 'pinned' | 'error';
  dir?: string;
  snapshot?: 'registry' | 'local';
  fileCount?: number;
  registryHash?: string | null;
  auditOverall?: string;
  isDuplicate?: true;
  error?: string;
  exitCode?: number;
}

export async function runPin(ids: string[], flags: PinFlags, ctx: CommandContext): Promise<number> {
  const existing = readLockfile(ctx.cwd);
  if (flags.all && ids.length > 0) throw usage('Pass either skill ids or --all, not both.');
  if (flags.all) {
    if (existing === null || Object.keys(existing.skills).length === 0) {
      throw usage(
        `--all found nothing to re-pin: no pinned skills here. Run 'skillwarden pin <id>' first.`,
      );
    }
    ids = Object.keys(existing.skills);
  }
  if (ids.length === 0) throw usage('pin requires at least one <id> (or --all).');
  if (flags.dir !== undefined && ids.length !== 1) {
    throw usage('--dir applies to exactly one skill id.');
  }

  const parsed = ids.map(parseSkillId);
  const { client, cache } = buildApi(ctx, flags);
  const discovered = await discoverSkills(defaultRoots(ctx.cwd, ctx.home));
  const lockDirs = Object.fromEntries(
    Object.entries(existing?.skills ?? {}).map(([id, s]) => [id, s.dir]),
  );

  let lf = existing ?? emptyLockfile(ctx.now());
  const results: PinResult[] = [];
  let pinnedCount = 0;

  for (const id of parsed) {
    try {
      const localDir = resolveLocalDir(id, ctx, flags.dir, lockDirs, discovered);
      let detail: SkillDetail;
      try {
        detail = await client.skillDetail(id);
      } catch (e) {
        if (e instanceof NotFoundError) throw skillNotFound(id.id);
        throw e;
      }
      const auditModel = modelAudits(await client.skillAudits(id));
      const { snapshot, files } = await pinFiles(detail, localDir);
      const isDuplicate = duplicateFlagFromCache(cache, id.id);
      const pin: PinnedSkill = {
        dir: toPosixRelative(ctx.cwd, localDir),
        pinnedAt: ctx.now().toISOString(),
        registryHash: detail.hash,
        installs: detail.installs,
        ...(isDuplicate === true ? { isDuplicate: true as const } : {}),
        snapshot,
        files,
        audits: toPinnedAudits(auditModel),
      };
      lf = upsertPin(lf, id.id, pin, ctx.now());
      pinnedCount += 1;
      results.push({
        id: id.id,
        status: 'pinned',
        dir: pin.dir,
        snapshot,
        fileCount: Object.keys(files).length,
        registryHash: detail.hash,
        auditOverall: auditModel.overall,
        ...(isDuplicate === true ? { isDuplicate: true as const } : {}),
      });
    } catch (e) {
      if (e instanceof CliError) {
        results.push({ id: id.id, status: 'error', error: e.message, exitCode: e.exitCode });
      } else {
        throw e;
      }
    }
  }

  if (pinnedCount > 0) writeLockfile(ctx.cwd, lf);

  const worst = results.reduce((w, r) => Math.max(w, r.exitCode ?? 0), 0);

  if (flags.json) {
    ctx.stdout(toJsonString({ command: 'pin', version: VERSION, results }));
    return worst as 0 | 1 | 2 | 3 | 4;
  }

  const c = colorsFor(ctx, flags);
  for (const r of results) {
    if (r.status === 'pinned') {
      const dup = r.isDuplicate === true ? `, ${c.yellow('duplicate of another skill')}` : '';
      const hash =
        r.registryHash === null ? 'no registry snapshot' : `hash ${r.registryHash!.slice(0, 12)}`;
      ctx.stdout(
        `${c.green('pinned')} ${c.bold(r.id)} (${r.fileCount} file${r.fileCount === 1 ? '' : 's'}, ${hash}, audits: ${r.auditOverall}${dup})`,
      );
    } else {
      ctx.stderr(`${c.red('error')} ${c.bold(r.id)}: ${r.error}`);
    }
  }
  if (pinnedCount > 0) {
    ctx.stdout(`Wrote skillwarden.lock.json (${Object.keys(lf.skills).length} pinned).`);
  }
  return worst as 0 | 1 | 2 | 3 | 4;
}
