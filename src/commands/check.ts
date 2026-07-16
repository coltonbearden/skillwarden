import path from 'node:path';
import type { SkillDetail } from '../api/types.ts';
import { modelAudits, type AuditModel } from '../core/audit-model.ts';
import {
  applyPolicy,
  conditionsFor,
  DEFAULT_POLICY,
  evaluate,
  parsePolicy,
  type CheckInputs,
  type CheckReport,
} from '../core/check-engine.ts';
import { defaultRoots, discoverSkills, type LocalSkill } from '../core/discovery.ts';
import { readLockfile, LOCKFILE_NAME } from '../core/lockfile.ts';
import { parseSkillId } from '../api/client.ts';
import { CliError, NotFoundError } from '../output/errors.ts';
import { renderTable, toJsonString, type Colors } from '../output/format.ts';
import { samePath } from '../util/paths.ts';
import {
  buildApi,
  colorsFor,
  hasToken,
  type CommandContext,
  type GlobalFlags,
} from '../context.ts';
import { VERSION } from '../version.ts';

export interface CheckFlags extends GlobalFlags {
  failOn?: string | undefined;
}

function localForPin(
  ctx: CommandContext,
  pinDir: string,
  local: LocalSkill[],
): LocalSkill | undefined {
  const abs = path.resolve(ctx.cwd, pinDir);
  return local.find(
    (s) =>
      samePath(abs, s.dir, process.platform) ||
      samePath(abs, s.realDir, process.platform) ||
      s.aliases.some((a) => samePath(abs, a, process.platform)),
  );
}

function stateColor(c: Colors, state: string): string {
  if (['ok', 'current', 'pass'].includes(state)) return c.green(state);
  if (['unknown', 'unaudited'].includes(state)) return c.dim(state);
  if (['warn', 'update-available', 'extra-file'].includes(state)) return c.yellow(state);
  return c.red(state);
}

const staleNote = (c: Colors, seconds: number | null): string =>
  seconds === null || seconds === 0 ? '' : ` ${c.dim(`(cached ${seconds}s ago)`)}`;

export async function runCheck(flags: CheckFlags, ctx: CommandContext): Promise<number> {
  const lockfile = readLockfile(ctx.cwd);
  if (lockfile === null) {
    throw new CliError(`No ${LOCKFILE_NAME} here. Run 'skillwarden pin <id>' first.`, 2);
  }
  const policy = flags.failOn !== undefined ? parsePolicy(flags.failOn) : DEFAULT_POLICY;
  const ids = Object.keys(lockfile.skills);
  const local = await discoverSkills(defaultRoots(ctx.cwd, ctx.home));

  const registry = new Map<string, SkillDetail | 'gone' | 'unknown'>();
  const audits = new Map<string, AuditModel | 'unknown'>();
  const registryStale = new Map<string, number | null>();
  const auditStale = new Map<string, number | null>();

  // Planes degrade to 'unknown' when data is unreachable for benign reasons:
  // an offline cache miss, or a 401 on an auth-gated route (the audit route is
  // anonymously readable today, the detail route is not — see D-10). Any other
  // API failure aborts: a half-checked report must not read as clean.
  let authLimited = false;
  const degradable = (e: unknown): boolean => {
    if (!(e instanceof CliError)) return false;
    if (flags.offline && e.exitCode === 3) return true;
    if (!flags.offline && e.exitCode === 4 && !hasToken(ctx)) {
      authLimited = true;
      return true;
    }
    return false;
  };
  {
    const { client } = buildApi(ctx, flags);
    for (const rawId of ids) {
      const id = parseSkillId(rawId);
      const detailUrl = client.urlFor(`/skills/${id.source}/${id.slug}`);
      const auditUrl = client.urlFor(`/skills/audit/${id.source}/${id.slug}`);
      try {
        registry.set(rawId, await client.skillDetail(id));
        registryStale.set(rawId, client.servedAge(detailUrl));
      } catch (e) {
        if (e instanceof NotFoundError) {
          registry.set(rawId, 'gone');
        } else if (degradable(e)) {
          registry.set(rawId, 'unknown');
        } else {
          throw e;
        }
      }
      try {
        audits.set(rawId, modelAudits(await client.skillAudits(id)));
        auditStale.set(rawId, client.servedAge(auditUrl));
      } catch (e) {
        if (degradable(e)) {
          audits.set(rawId, 'unknown');
        } else {
          throw e;
        }
      }
    }
  }
  if (authLimited) {
    ctx.stderr(
      'skillwarden: no SKILLS_SH_API_KEY set — auth-gated planes reported as unknown ' +
        '(integrity still checked). See README > Authentication.',
    );
  }

  const localById = new Map(
    ids.map((id) => [id, localForPin(ctx, lockfile.skills[id]!.dir, local)]),
  );
  const inputs: CheckInputs = {
    lockfile,
    local,
    registry,
    audits,
    registryStale,
    auditStale,
    localById,
  };
  const report = evaluate(inputs);
  const verdict = applyPolicy(report, policy);

  if (flags.json) {
    ctx.stdout(
      toJsonString({
        command: 'check',
        version: VERSION,
        policy,
        verdict,
        skills: report.skills,
        notPinned: report.notPinned,
      }),
    );
    return verdict.failed ? 1 : 0;
  }

  const c = colorsFor(ctx, flags);
  renderHuman(ctx, c, report, verdict.matched, policy);
  return verdict.failed ? 1 : 0;
}

function renderHuman(
  ctx: CommandContext,
  c: Colors,
  report: CheckReport,
  matched: string[],
  policy: string[],
): void {
  if (report.skills.length === 0) {
    ctx.stdout('Lockfile has no pinned skills.');
  }
  for (const s of report.skills) {
    ctx.stdout(`${c.bold(s.id)}  ${c.dim(s.dir)}`);
    const integrityNote =
      s.integrity.details.length > 0 ? ` — ${s.integrity.details.join(', ')}` : '';
    ctx.stdout(`  integrity: ${stateColor(c, s.integrity.state)}${integrityNote}`);
    const regNote = s.registry.note !== null ? ` — ${s.registry.note}` : '';
    ctx.stdout(
      `  registry:  ${stateColor(c, s.registry.state)}${regNote}${staleNote(c, s.registry.staleSeconds)}`,
    );
    const regressedNote = s.audit.regressed
      ? ` — ${c.red('regressed since pin')}: ${s.audit.changes.join('; ')}`
      : s.audit.changes.length > 0
        ? ` — ${s.audit.changes.join('; ')}`
        : '';
    ctx.stdout(
      `  audits:    ${stateColor(c, s.audit.overall)}${regressedNote}${staleNote(c, s.audit.staleSeconds)}`,
    );
    if (s.isDuplicate) {
      ctx.stdout(`  ${c.yellow('flagged as a duplicate/fork of another skill')}`);
    }
    ctx.stdout('');
  }
  if (report.notPinned.length > 0) {
    ctx.stdout('Local skills not in the lockfile (informational):');
    for (const line of renderTable(
      ['skill', 'location'],
      report.notPinned.map((s) => [s.slug, s.dir]),
    )) {
      ctx.stdout(`  ${line}`);
    }
    ctx.stdout('');
  }
  const findings = report.skills.flatMap((s) => conditionsFor(s).map((cond) => `${s.id}: ${cond}`));
  const summary =
    findings.length === 0
      ? c.green('no findings')
      : `${findings.length} finding${findings.length === 1 ? '' : 's'} (${findings.join('; ')})`;
  const gate =
    matched.length > 0
      ? c.red(`FAIL on [${policy.join(',')}]`)
      : c.green(`OK under [${policy.join(',') || 'none'}]`);
  ctx.stdout(
    `${report.skills.length} pinned skill${report.skills.length === 1 ? '' : 's'} checked: ${summary}. Policy: ${gate}.`,
  );
}
