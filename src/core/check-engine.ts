import type { SkillDetail } from '../api/types.ts';
import { compareAudits, type AuditModel } from './audit-model.ts';
import type { LocalSkill } from './discovery.ts';
import type { Lockfile } from './lockfile.ts';
import { usage } from '../output/errors.ts';

export type IntegrityState =
  | 'ok'
  | 'modified'
  | 'missing-file'
  | 'extra-file'
  | 'dir-missing'
  | 'unknown';

export type RegistryState = 'current' | 'update-available' | 'gone' | 'unknown';

export interface SkillCheck {
  id: string;
  dir: string;
  integrity: { state: IntegrityState; details: string[] };
  registry: { state: RegistryState; note: string | null; staleSeconds: number | null };
  audit: {
    overall: AuditModel['overall'] | 'unknown';
    regressed: boolean;
    changes: string[];
    staleSeconds: number | null;
  };
  isDuplicate: boolean;
}

export interface CheckReport {
  skills: SkillCheck[];
  /** Local skills on disk that are not pinned (informational). */
  notPinned: { slug: string; dir: string }[];
}

export interface CheckInputs {
  lockfile: Lockfile;
  local: LocalSkill[];
  /** Keyed by registry id. 'unknown' = could not consult registry (offline/no token). */
  registry: Map<string, SkillDetail | 'gone' | 'unknown'>;
  audits: Map<string, AuditModel | 'unknown'>;
  /** Cache age in seconds for data served from cache; null = live. Keyed by id. */
  registryStale: Map<string, number | null>;
  auditStale: Map<string, number | null>;
  /** Local skill matched to each pinned id (by dir), if present on disk. */
  localById: Map<string, LocalSkill | undefined>;
}

function checkIntegrity(
  pinned: { files: Record<string, string> },
  local: LocalSkill | undefined,
): { state: IntegrityState; details: string[] } {
  if (local === undefined) return { state: 'dir-missing', details: ['local directory is gone'] };
  if (local.unreadable) {
    return { state: 'unknown', details: ['some local files could not be read'] };
  }
  const details: string[] = [];
  let modified = false;
  let missing = false;
  let extra = false;
  for (const [p, hex] of Object.entries(pinned.files)) {
    const localHex = local.fingerprint.files[p];
    if (localHex === undefined) {
      missing = true;
      details.push(`missing: ${p}`);
    } else if (localHex !== hex) {
      modified = true;
      details.push(`modified: ${p}`);
    }
  }
  for (const p of Object.keys(local.fingerprint.files)) {
    if (!(p in pinned.files)) {
      extra = true;
      details.push(`extra: ${p}`);
    }
  }
  const state: IntegrityState = modified
    ? 'modified'
    : missing
      ? 'missing-file'
      : extra
        ? 'extra-file'
        : 'ok';
  return { state, details };
}

function checkRegistry(
  pinnedHash: string | null,
  current: SkillDetail | 'gone' | 'unknown',
): { state: RegistryState; note: string | null } {
  if (current === 'gone') return { state: 'gone', note: 'no longer in the registry' };
  if (current === 'unknown') return { state: 'unknown', note: null };
  if (pinnedHash === null && current.hash === null) {
    return { state: 'unknown', note: 'registry has no content snapshot to compare' };
  }
  if (pinnedHash === null && current.hash !== null) {
    return {
      state: 'unknown',
      note: 'registry gained a content snapshot since pin; re-pin to track it',
    };
  }
  if (current.hash === null) {
    return { state: 'unknown', note: 'registry snapshot disappeared since pin' };
  }
  return current.hash === pinnedHash
    ? { state: 'current', note: null }
    : { state: 'update-available', note: 'upstream content changed since pin' };
}

export function evaluate(inputs: CheckInputs): CheckReport {
  const skills: SkillCheck[] = [];
  for (const [id, pin] of Object.entries(inputs.lockfile.skills).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const local = inputs.localById.get(id);
    const integrity = checkIntegrity(pin, local);
    const registry = checkRegistry(pin.registryHash, inputs.registry.get(id) ?? 'unknown');
    const auditModel = inputs.audits.get(id) ?? 'unknown';
    const audit =
      auditModel === 'unknown'
        ? { regressed: false, changes: [], overall: 'unknown' as const }
        : { ...compareAudits(pin.audits, auditModel), overall: auditModel.overall };
    skills.push({
      id,
      dir: pin.dir,
      integrity,
      registry: { ...registry, staleSeconds: inputs.registryStale.get(id) ?? null },
      audit: { ...audit, staleSeconds: inputs.auditStale.get(id) ?? null },
      isDuplicate: pin.isDuplicate === true,
    });
  }

  const pinnedDirs = new Set(Object.values(inputs.lockfile.skills).map((s) => s.dir));
  const claimed = new Set(
    [...inputs.localById.values()].filter(Boolean).map((s) => (s as LocalSkill).realDir),
  );
  const notPinned = inputs.local
    .filter((s) => !claimed.has(s.realDir))
    .map((s) => ({ slug: s.slug, dir: s.dir }))
    .filter((s) => !pinnedDirs.has(s.dir));
  return { skills, notPinned };
}

export const POLICY_CONDITIONS = [
  'tamper',
  'drift',
  'audit-fail',
  'audit-warn',
  'unaudited',
  'duplicate',
  'gone',
] as const;

export type PolicyCond = (typeof POLICY_CONDITIONS)[number];

export const DEFAULT_POLICY: PolicyCond[] = ['tamper', 'audit-fail'];

export function parsePolicy(raw: string): PolicyCond[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 1 && parts[0] === 'none') return [];
  const out: PolicyCond[] = [];
  for (const p of parts) {
    if (p === 'none') throw usage(`--fail-on 'none' cannot be combined with other conditions.`);
    if (!(POLICY_CONDITIONS as readonly string[]).includes(p)) {
      throw usage(
        `Unknown --fail-on condition '${p}'. Valid: ${POLICY_CONDITIONS.join(', ')}, none.`,
      );
    }
    out.push(p as PolicyCond);
  }
  if (out.length === 0) throw usage('--fail-on requires at least one condition (or none).');
  return [...new Set(out)];
}

const TAMPER_STATES: IntegrityState[] = ['modified', 'missing-file', 'extra-file', 'dir-missing'];

/** Conditions a single skill triggers. */
export function conditionsFor(s: SkillCheck): PolicyCond[] {
  const out: PolicyCond[] = [];
  if (TAMPER_STATES.includes(s.integrity.state)) out.push('tamper');
  if (s.registry.state === 'update-available') out.push('drift');
  if (s.registry.state === 'gone') out.push('gone');
  if (s.audit.overall === 'fail') out.push('audit-fail');
  if (s.audit.overall === 'warn') out.push('audit-warn');
  if (s.audit.overall === 'unaudited') out.push('unaudited');
  if (s.isDuplicate) out.push('duplicate');
  return out;
}

export interface PolicyVerdict {
  failed: boolean;
  /** "id: condition" strings for everything at/above policy. */
  matched: string[];
}

export function applyPolicy(report: CheckReport, policy: PolicyCond[]): PolicyVerdict {
  const matched: string[] = [];
  for (const s of report.skills) {
    for (const cond of conditionsFor(s)) {
      if (policy.includes(cond)) matched.push(`${s.id}: ${cond}`);
    }
  }
  return { failed: matched.length > 0, matched };
}
