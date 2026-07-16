import fs from 'node:fs';
import path from 'node:path';
import { defaultRoots, discoverSkills, type LocalSkill } from '../core/discovery.ts';
import { readLockfile } from '../core/lockfile.ts';
import { usage } from '../output/errors.ts';
import { renderTable, toJsonString } from '../output/format.ts';
import { samePath, toPosixRelative } from '../util/paths.ts';
import { colorsFor, type CommandContext, type GlobalFlags } from '../context.ts';
import { VERSION } from '../version.ts';

export interface ScanFlags extends GlobalFlags {
  roots: string[];
}

function displayDir(ctx: CommandContext, dir: string): string {
  const rel = path.relative(ctx.cwd, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  if (dir.startsWith(ctx.home)) return `~${dir.slice(ctx.home.length).split(path.sep).join('/')}`;
  return dir;
}

/** Registry id pinned for this local dir, or null. */
function pinnedIdFor(
  ctx: CommandContext,
  lockSkills: Record<string, { dir: string }>,
  skill: LocalSkill,
): string | null {
  for (const [id, pin] of Object.entries(lockSkills)) {
    const abs = path.resolve(ctx.cwd, pin.dir);
    if (
      samePath(abs, skill.dir, process.platform) ||
      samePath(abs, skill.realDir, process.platform) ||
      skill.aliases.some((a) => samePath(abs, a, process.platform))
    ) {
      return id;
    }
  }
  return null;
}

export async function runScan(flags: ScanFlags, ctx: CommandContext): Promise<number> {
  const roots =
    flags.roots.length > 0
      ? flags.roots.map((r) => {
          const abs = path.resolve(ctx.cwd, r);
          if (!fs.existsSync(abs)) throw usage(`--root '${r}' does not exist.`);
          return abs;
        })
      : defaultRoots(ctx.cwd, ctx.home);

  const skills = await discoverSkills(roots);
  const lock = readLockfile(ctx.cwd);
  const lockSkills = lock?.skills ?? {};

  if (flags.json) {
    ctx.stdout(
      toJsonString({
        command: 'scan',
        version: VERSION,
        skills: skills.map((s) => ({
          slug: s.slug,
          dir: toPosixRelative(ctx.cwd, s.dir) || '.',
          absoluteDir: s.dir,
          aliases: s.aliases,
          name: s.frontmatter.name ?? null,
          description: s.frontmatter.description ?? null,
          fileCount: Object.keys(s.fingerprint.files).length,
          combinedDigest: s.fingerprint.combined,
          unreadable: s.unreadable,
          pinnedAs: lock === null ? null : pinnedIdFor(ctx, lockSkills, s),
        })),
      }),
    );
    return 0;
  }

  const c = colorsFor(ctx, flags);
  if (skills.length === 0) {
    ctx.stdout('No skills found. Scanned roots:');
    for (const r of roots) ctx.stdout(`  ${displayDir(ctx, r)}`);
    return 0;
  }

  const rows = skills.map((s) => {
    const pinned = lock === null ? null : pinnedIdFor(ctx, lockSkills, s);
    const notes: string[] = [];
    if (s.aliases.length > 0) notes.push(`+${s.aliases.length} link`);
    if (s.unreadable) notes.push(c.yellow('unreadable files'));
    if (lock !== null && pinned === null) notes.push(c.yellow('not in lockfile'));
    if (pinned !== null) notes.push(c.green(`pinned as ${pinned}`));
    return [
      c.bold(s.slug),
      displayDir(ctx, s.dir),
      String(Object.keys(s.fingerprint.files).length),
      c.dim(s.fingerprint.combined.slice(0, 12)),
      notes.join(', '),
    ];
  });
  for (const line of renderTable(['skill', 'location', 'files', 'digest', 'notes'], rows)) {
    ctx.stdout(line);
  }
  ctx.stdout('');
  const hint = lock === null ? " (no lockfile — run 'skillwarden pin <id>' to start pinning)" : '';
  ctx.stdout(`${skills.length} skill${skills.length === 1 ? '' : 's'} found${hint}.`);
  return 0;
}
