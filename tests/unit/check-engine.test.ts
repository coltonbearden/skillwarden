import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillDetail } from '../../src/api/types.ts';
import { modelAudits, type AuditModel } from '../../src/core/audit-model.ts';
import {
  applyPolicy,
  conditionsFor,
  DEFAULT_POLICY,
  evaluate,
  parsePolicy,
  type CheckInputs,
} from '../../src/core/check-engine.ts';
import type { LocalSkill } from '../../src/core/discovery.ts';
import type { Lockfile, PinnedSkill } from '../../src/core/lockfile.ts';
import { CliError } from '../../src/output/errors.ts';
import { parseAudits } from '../../src/api/types.ts';
import { loadFixture } from '../helpers.ts';

const ID = 'acme/skills/demo';

function pin(over: Partial<PinnedSkill> = {}): PinnedSkill {
  return {
    dir: '.claude/skills/demo',
    pinnedAt: '2026-07-15T00:00:00Z',
    registryHash: 'aa'.repeat(32),
    installs: 10,
    snapshot: 'registry',
    files: { 'SKILL.md': '11'.repeat(32), 'ref.md': '22'.repeat(32) },
    audits: { socket: { status: 'pass', riskLevel: 'NONE', auditedAt: '' } },
    ...over,
  };
}

function local(files: Record<string, string>, over: Partial<LocalSkill> = {}): LocalSkill {
  return {
    slug: 'demo',
    dir: '/abs/.claude/skills/demo',
    realDir: '/abs/.claude/skills/demo',
    aliases: [],
    fingerprint: { files, combined: 'x' },
    frontmatter: {},
    unreadable: false,
    ...over,
  };
}

function detail(hash: string | null): SkillDetail {
  return { id: ID, source: 'acme/skills', slug: 'demo', installs: 12, hash, files: null };
}

const passAudit = (): AuditModel => modelAudits(parseAudits(loadFixture('audit-results.json')));
const failAudit = (): AuditModel => modelAudits(parseAudits(loadFixture('audit-mixed.json')));

function inputs(over: Partial<CheckInputs> = {}): CheckInputs {
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    pinnedAt: '2026-07-15T00:00:00Z',
    skills: { [ID]: pin() },
  };
  const matchingLocal = local({ 'SKILL.md': '11'.repeat(32), 'ref.md': '22'.repeat(32) });
  return {
    lockfile,
    local: [matchingLocal],
    registry: new Map([[ID, detail('aa'.repeat(32))]]),
    audits: new Map([[ID, passAudit()]]),
    registryStale: new Map([[ID, null]]),
    auditStale: new Map([[ID, null]]),
    localById: new Map([[ID, matchingLocal]]),
    ...over,
  };
}

test('clean skill: ok / current / pass and no policy findings', () => {
  const report = evaluate(inputs());
  const s = report.skills[0]!;
  assert.equal(s.integrity.state, 'ok');
  assert.equal(s.registry.state, 'current');
  assert.equal(s.audit.overall, 'pass');
  assert.deepEqual(conditionsFor(s), []);
  assert.equal(applyPolicy(report, DEFAULT_POLICY).failed, false);
});

test('integrity: modified, missing, extra, dir-missing, unreadable', () => {
  const cases: [Record<string, string> | undefined, string, boolean?][] = [
    [{ 'SKILL.md': 'ff'.repeat(32), 'ref.md': '22'.repeat(32) }, 'modified'],
    [{ 'ref.md': '22'.repeat(32) }, 'missing-file'],
    [
      { 'SKILL.md': '11'.repeat(32), 'ref.md': '22'.repeat(32), 'new.md': '33'.repeat(32) },
      'extra-file',
    ],
    [undefined, 'dir-missing'],
    [{ 'SKILL.md': '11'.repeat(32), 'ref.md': '22'.repeat(32) }, 'unknown', true],
  ];
  for (const [files, expected, unreadable] of cases) {
    const l =
      files === undefined ? undefined : local(files, unreadable ? { unreadable: true } : {});
    const report = evaluate(
      inputs({ localById: new Map([[ID, l]]), local: l === undefined ? [] : [l] }),
    );
    assert.equal(report.skills[0]!.integrity.state, expected, expected);
  }
});

test('modified wins over missing/extra in state precedence', () => {
  const l = local({ 'SKILL.md': 'ff'.repeat(32), 'other.md': '44'.repeat(32) });
  const report = evaluate(inputs({ localById: new Map([[ID, l]]) }));
  assert.equal(report.skills[0]!.integrity.state, 'modified');
  assert.equal(report.skills[0]!.integrity.details.length, 3);
});

test('registry: drift, gone, unknown, and null-hash asymmetries', () => {
  const drift = evaluate(inputs({ registry: new Map([[ID, detail('bb'.repeat(32))]]) }));
  assert.equal(drift.skills[0]!.registry.state, 'update-available');

  const gone = evaluate(inputs({ registry: new Map([[ID, 'gone']]) }));
  assert.equal(gone.skills[0]!.registry.state, 'gone');

  const unknown = evaluate(inputs({ registry: new Map() }));
  assert.equal(unknown.skills[0]!.registry.state, 'unknown');

  const bothNull = evaluate(
    inputs({
      lockfile: { lockfileVersion: 1, pinnedAt: '', skills: { [ID]: pin({ registryHash: null }) } },
      registry: new Map([[ID, detail(null)]]),
    }),
  );
  assert.equal(bothNull.skills[0]!.registry.state, 'unknown');
  assert.match(bothNull.skills[0]!.registry.note!, /no content snapshot/);

  const gained = evaluate(
    inputs({
      lockfile: { lockfileVersion: 1, pinnedAt: '', skills: { [ID]: pin({ registryHash: null }) } },
      registry: new Map([[ID, detail('cc'.repeat(32))]]),
    }),
  );
  assert.match(gained.skills[0]!.registry.note!, /re-pin/);
});

test('audits: fail flags policy, regression tracked, unknown tolerated', () => {
  const failing = evaluate(inputs({ audits: new Map([[ID, failAudit()]]) }));
  const s = failing.skills[0]!;
  assert.equal(s.audit.overall, 'fail');
  assert.equal(s.audit.regressed, true);
  assert.ok(conditionsFor(s).includes('audit-fail'));

  const unknown = evaluate(inputs({ audits: new Map() }));
  assert.equal(unknown.skills[0]!.audit.overall, 'unknown');
  assert.deepEqual(conditionsFor(unknown.skills[0]!), []);
});

test('unaudited and duplicate conditions fire only under matching policy', () => {
  const report = evaluate(
    inputs({
      lockfile: {
        lockfileVersion: 1,
        pinnedAt: '',
        skills: { [ID]: pin({ isDuplicate: true }) },
      },
      audits: new Map([[ID, modelAudits('unaudited')]]),
    }),
  );
  const conds = conditionsFor(report.skills[0]!);
  assert.deepEqual(conds.sort(), ['duplicate', 'unaudited']);
  assert.equal(applyPolicy(report, DEFAULT_POLICY).failed, false);
  assert.equal(applyPolicy(report, parsePolicy('unaudited,duplicate')).failed, true);
});

test('notPinned lists unclaimed local skills', () => {
  const extraLocal = local(
    { 'SKILL.md': 'ab'.repeat(32) },
    {
      slug: 'stray',
      dir: '/abs/.claude/skills/stray',
      realDir: '/abs/.claude/skills/stray',
    },
  );
  const base = inputs();
  const report = evaluate(inputs({ local: [...base.local, extraLocal] }));
  assert.deepEqual(report.notPinned, [{ slug: 'stray', dir: '/abs/.claude/skills/stray' }]);
});

test('parsePolicy: valid lists, none, duplicates collapse, invalid rejected', () => {
  assert.deepEqual(parsePolicy('tamper,audit-fail,tamper'), ['tamper', 'audit-fail']);
  assert.deepEqual(parsePolicy('none'), []);
  for (const bad of ['nope', 'tamper,none', '', ' ,']) {
    assert.throws(
      () => parsePolicy(bad),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
      bad,
    );
  }
});

test('applyPolicy reports id-tagged matches', () => {
  const report = evaluate(inputs({ registry: new Map([[ID, detail('bb'.repeat(32))]]) }));
  const verdict = applyPolicy(report, parsePolicy('drift'));
  assert.deepEqual(verdict.matched, [`${ID}: drift`]);
});
