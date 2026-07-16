import type { AuditResponse, AuditStatus } from '../api/types.ts';

export type OverallAudit = AuditStatus | 'unaudited';

export interface PartnerAudit {
  provider: string;
  slug: string;
  status: AuditStatus;
  summary: string;
  auditedAt: string;
  riskLevel: string | null;
  categories: string[];
}

export interface AuditModel {
  overall: OverallAudit;
  partners: PartnerAudit[];
}

/** Lockfile snapshot: partner slug -> pinned facts. Empty object = unaudited at pin. */
export type PinnedAudits = Record<
  string,
  { status: AuditStatus; riskLevel: string | null; auditedAt: string }
>;

const STATUS_RANK: Record<AuditStatus, number> = { pass: 0, warn: 1, fail: 2 };
// SAFE observed live 2026-07-15 (Gen Agent Trust Hub) alongside the documented
// NONE→CRITICAL scale; unknown levels never participate in regression checks.
const RISK_RANK: Record<string, number> = {
  SAFE: 0,
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function modelAudits(input: AuditResponse | 'unaudited'): AuditModel {
  if (input === 'unaudited' || input.audits.length === 0) {
    return { overall: 'unaudited', partners: [] };
  }
  const partners = input.audits
    .map((a) => ({
      provider: a.provider,
      slug: a.slug,
      status: a.status,
      summary: a.summary,
      auditedAt: a.auditedAt,
      riskLevel: a.riskLevel ?? null,
      categories: a.categories ?? [],
    }))
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.slug.localeCompare(b.slug));
  const overall = partners.reduce<AuditStatus>(
    (worst, p) => (STATUS_RANK[p.status] > STATUS_RANK[worst] ? p.status : worst),
    'pass',
  );
  return { overall, partners };
}

export function toPinnedAudits(model: AuditModel): PinnedAudits {
  const out: PinnedAudits = {};
  for (const p of [...model.partners].sort((a, b) => a.slug.localeCompare(b.slug))) {
    out[p.slug] = { status: p.status, riskLevel: p.riskLevel, auditedAt: p.auditedAt };
  }
  return out;
}

export interface AuditComparison {
  regressed: boolean;
  changes: string[];
}

/**
 * Regression rules (see docs/PLAN.md T8): a partner's status worsening or riskLevel
 * rising regresses; a new warn/fail partner regresses; a partner disappearing does not
 * (partner coverage fluctuates); unknown risk levels never regress.
 */
export function compareAudits(pinned: PinnedAudits, current: AuditModel): AuditComparison {
  const changes: string[] = [];
  let regressed = false;

  for (const p of current.partners) {
    const was = pinned[p.slug];
    if (was === undefined) {
      if (p.status !== 'pass') {
        regressed = true;
        changes.push(`${p.provider}: new '${p.status}' finding since pin`);
      }
      continue;
    }
    if (STATUS_RANK[p.status] > STATUS_RANK[was.status]) {
      regressed = true;
      changes.push(`${p.provider}: ${was.status} -> ${p.status}`);
    }
    const oldRisk = was.riskLevel !== null ? RISK_RANK[was.riskLevel] : undefined;
    const newRisk = p.riskLevel !== null ? RISK_RANK[p.riskLevel] : undefined;
    if (oldRisk !== undefined && newRisk !== undefined && newRisk > oldRisk) {
      regressed = true;
      changes.push(`${p.provider}: risk ${was.riskLevel} -> ${p.riskLevel}`);
    }
  }

  const pinnedHadAny = Object.keys(pinned).length > 0;
  if (pinnedHadAny && current.overall === 'unaudited') {
    changes.push('all partner audits disappeared since pin');
  }
  return { regressed, changes };
}
