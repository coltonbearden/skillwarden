import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudits } from '../../src/api/types.ts';
import {
  compareAudits,
  modelAudits,
  toPinnedAudits,
  type AuditModel,
} from '../../src/core/audit-model.ts';
import { loadFixture } from '../helpers.ts';

const full = () => modelAudits(parseAudits(loadFixture('audit-results.json')));
const mixed = () => modelAudits(parseAudits(loadFixture('audit-mixed.json')));

test('all-pass audits give overall pass with 5 partners', () => {
  const m = full();
  assert.equal(m.overall, 'pass');
  assert.equal(m.partners.length, 5);
});

test('mixed audits give overall fail, worst first', () => {
  const m = mixed();
  assert.equal(m.overall, 'fail');
  assert.equal(m.partners[0]!.status, 'fail');
  assert.equal(m.partners[0]!.provider, 'Socket');
});

test('unaudited and empty-audits both model as unaudited', () => {
  assert.equal(modelAudits('unaudited').overall, 'unaudited');
  assert.equal(modelAudits({ id: 'x', source: 'x', slug: 'x', audits: [] }).overall, 'unaudited');
});

test('unknown provider and riskLevel strings pass through', () => {
  const m = modelAudits(
    parseAudits({
      id: 'a/b/c',
      source: 'a/b',
      slug: 'c',
      audits: [
        { provider: 'NewPartner', slug: 'new-partner', status: 'warn', summary: '', auditedAt: '', riskLevel: 'ELEVATED' },
      ],
    }),
  );
  assert.equal(m.overall, 'warn');
  assert.equal(m.partners[0]!.riskLevel, 'ELEVATED');
});

test('regression: status worsening is flagged', () => {
  const pinned = toPinnedAudits(full());
  const worse: AuditModel = {
    overall: 'fail',
    partners: full().partners.map((p) =>
      p.slug === 'socket' ? { ...p, status: 'fail' as const } : p,
    ),
  };
  const cmp = compareAudits(pinned, worse);
  assert.equal(cmp.regressed, true);
  assert.match(cmp.changes.join('\n'), /Socket: pass -> fail/);
});

test('regression: risk level rising is flagged; unknown levels are not', () => {
  const pinned = toPinnedAudits(full());
  const riskier: AuditModel = {
    overall: 'pass',
    partners: full().partners.map((p) =>
      p.slug === 'snyk' ? { ...p, riskLevel: 'HIGH' } : p,
    ),
  };
  assert.equal(compareAudits(pinned, riskier).regressed, true);

  const weird: AuditModel = {
    overall: 'pass',
    partners: full().partners.map((p) =>
      p.slug === 'snyk' ? { ...p, riskLevel: 'MYSTERY' } : p,
    ),
  };
  assert.equal(compareAudits(pinned, weird).regressed, false);
});

test('new warn/fail partner regresses; new pass partner does not', () => {
  const pinned = toPinnedAudits(modelAudits(parseAudits(loadFixture('audit-mixed.json'))));
  const withNewPass: AuditModel = {
    overall: 'fail',
    partners: [
      ...mixed().partners,
      { provider: 'Fresh', slug: 'fresh', status: 'pass', summary: '', auditedAt: '', riskLevel: null, categories: [] },
    ],
  };
  assert.equal(compareAudits(pinned, withNewPass).regressed, false);

  const withNewFail: AuditModel = {
    overall: 'fail',
    partners: [
      ...mixed().partners,
      { provider: 'Fresh', slug: 'fresh', status: 'fail', summary: '', auditedAt: '', riskLevel: null, categories: [] },
    ],
  };
  assert.equal(compareAudits(pinned, withNewFail).regressed, true);
});

test('partner disappearing is noted but not a regression', () => {
  const pinned = toPinnedAudits(full());
  const cmp = compareAudits(pinned, { overall: 'unaudited', partners: [] });
  assert.equal(cmp.regressed, false);
  assert.match(cmp.changes.join('\n'), /disappeared/);
});

test('improvement is never a regression', () => {
  const pinned = toPinnedAudits(mixed());
  assert.equal(compareAudits(pinned, full()).regressed, false);
});
