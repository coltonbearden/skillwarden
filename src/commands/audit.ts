import { parseSkillId } from '../api/client.ts';
import { modelAudits } from '../core/audit-model.ts';
import { NotFoundError, skillNotFound, usage } from '../output/errors.ts';
import { renderTable, toJsonString, truncate, type Colors } from '../output/format.ts';
import { buildApi, colorsFor, type CommandContext, type GlobalFlags } from '../context.ts';
import { VERSION } from '../version.ts';

const SUMMARY_WIDTH = 60;

function statusColor(c: Colors, status: string): string {
  if (status === 'pass') return c.green(status);
  if (status === 'warn') return c.yellow(status);
  if (status === 'fail') return c.red(status);
  return c.dim(status);
}

export async function runAudit(
  ids: string[],
  flags: GlobalFlags,
  ctx: CommandContext,
): Promise<number> {
  if (ids.length !== 1) {
    throw usage(`audit takes exactly one skill id, got ${ids.length}.`);
  }
  const id = parseSkillId(ids[0]!);
  const { client } = buildApi(ctx, flags);

  let result;
  try {
    result = await client.skillAudits(id);
  } catch (e) {
    if (e instanceof NotFoundError) throw skillNotFound(id.id);
    throw e;
  }
  const model = modelAudits(result);
  const url = client.urlFor(`/skills/audit/${id.source}/${id.slug}`);
  const staleSeconds = client.servedAge(url);

  if (flags.json) {
    ctx.stdout(
      toJsonString({
        command: 'audit',
        version: VERSION,
        id: id.id,
        overall: model.overall,
        partners: model.partners,
        cacheAgeSeconds: staleSeconds,
      }),
    );
    return 0;
  }

  const c = colorsFor(ctx, flags);
  if (model.overall === 'unaudited') {
    ctx.stdout(
      `No audits yet for '${id.id}' — audits are generated automatically shortly after a skill's first install.`,
    );
    return 0;
  }

  ctx.stdout(`${c.bold(id.id)} — security audits`);
  ctx.stdout('');
  const rows = model.partners.map((p) => [
    p.provider,
    statusColor(c, p.status),
    p.riskLevel ?? c.dim('-'),
    p.auditedAt === '' ? c.dim('-') : p.auditedAt.slice(0, 10),
    truncate(p.summary, SUMMARY_WIDTH) + (p.categories.length > 0 ? c.dim(` [${p.categories.join(', ')}]`) : ''),
  ]);
  for (const line of renderTable(['partner', 'status', 'risk', 'audited', 'summary'], rows)) {
    ctx.stdout(line);
  }
  ctx.stdout('');
  const stale = staleSeconds !== null && staleSeconds > 0 ? c.dim(` (cached ${staleSeconds}s ago)`) : '';
  ctx.stdout(`overall: ${statusColor(c, model.overall)} (worst of ${model.partners.length} partner${model.partners.length === 1 ? '' : 's'})${stale}`);
  return 0;
}
