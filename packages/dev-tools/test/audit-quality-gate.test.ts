import { describe, expect, it } from 'vitest';

import {
  type AuditFinding,
  type Exemption,
  auditRunFailure,
  classifyFindings,
  findStaleExemptions,
  parseAuditFindings,
} from '../src/audit-quality-gate.js';

/**
 * The gate's decision is pure, so every case below is a unit test. The half that
 * spawns `vat audit` is a two-line shell-out with nothing to assert about.
 */

function finding(over: Partial<AuditFinding> = {}): AuditFinding {
  return { file: 'packages/x/SKILL.md', code: 'SOME_CODE', severity: 'warning', message: 'm', ...over };
}

const structural = (over: Partial<Exemption> = {}): Exemption => ({
  kind: 'structural',
  pathPrefix: 'packages/x/',
  codes: [],
  reason: 'test',
  ...over,
});

describe('classifyFindings', () => {
  it('fails an unexempted warning — a warning is a failure with a softer name', () => {
    const result = classifyFindings([finding()], []);
    expect(result.unexpected).toHaveLength(1);
    expect(result.excused).toHaveLength(0);
  });

  it('ignores info, which is advice rather than a defect', () => {
    const result = classifyFindings([finding({ severity: 'info' })], []);
    expect(result.unexpected).toHaveLength(0);
  });

  it('fails an error just as it fails a warning', () => {
    expect(classifyFindings([finding({ severity: 'error' })], []).unexpected).toHaveLength(1);
  });

  it('lets `ignore` through — a severity the author deliberately silenced', () => {
    expect(classifyFindings([finding({ severity: 'ignore' })], []).unexpected).toHaveLength(0);
  });

  it('FAILS a severity it does not recognise, rather than dropping the finding', () => {
    // The gate's whole premise is that a report it cannot read must not be
    // indistinguishable from a clean repository. An allowlist of FAILING
    // severities breaks that promise at exactly one field: rename `warning`
    // upstream, or let `parseAuditFindings` fall back to `<unknown>` because the
    // field went missing, and the finding silently stops failing. So the
    // classification is an allowlist of ADVISORY severities instead — anything
    // unrecognised is a failure, which is the safe direction for a gate.
    expect(classifyFindings([finding({ severity: '<unknown>' })], []).unexpected).toHaveLength(1);
    expect(classifyFindings([finding({ severity: 'critical' })], []).unexpected).toHaveLength(1);
  });

  it('excuses a finding under a matching path prefix', () => {
    const result = classifyFindings([finding()], [structural()]);
    expect(result.unexpected).toHaveLength(0);
    expect(result.excused[0]?.exemption.pathPrefix).toBe('packages/x/');
  });

  it('does NOT excuse a neighbouring path that merely shares a parent', () => {
    const result = classifyFindings([finding({ file: 'packages/xy/SKILL.md' })], [structural()]);
    expect(result.unexpected).toHaveLength(1);
  });

  // The code-scoped exemption is the one that carries real risk: it must excuse
  // the ONE code its reason argues about and nothing else under the same path.
  it('excuses only the listed code when codes are named', () => {
    const exemptions = [structural({ codes: ['PLUGIN_MISSING_VERSION'] })];
    const result = classifyFindings(
      [finding({ code: 'PLUGIN_MISSING_VERSION' }), finding({ code: 'SOMETHING_ELSE' })],
      exemptions,
    );
    expect(result.excused).toHaveLength(1);
    expect(result.unexpected.map((f) => f.code)).toEqual(['SOMETHING_ELSE']);
  });
});

describe('findStaleExemptions', () => {
  it('reports an exemption that matches nothing, so the register cannot rot', () => {
    expect(findStaleExemptions([structural({ pathPrefix: 'gone/' })], [finding()])).toHaveLength(1);
  });

  it('reports nothing when every exemption is still earning its place', () => {
    expect(findStaleExemptions([structural()], [finding()])).toHaveLength(0);
  });

  // An exemption is judged against FAILING findings only. If the underlying
  // finding drops to info, the exemption is no longer doing any work and must
  // be deleted rather than left as a comment about the past.
  it('treats an exemption whose finding fell to info as stale', () => {
    const result = classifyFindings([finding({ severity: 'info' })], [structural()]);
    expect(result.staleExemptions).toHaveLength(1);
  });
});

describe('parseAuditFindings', () => {
  const report = `
status: findings
examined: 2
findings:
  - severity: warning
    code: TOO_LONG
    message: long
    location: a/SKILL.md
summary: { errors: 0, warnings: 1, info: 0 }
gate: { strict: false }
data: { files: [] }
`;

  it('reads every finding and attributes it to the file it names', () => {
    const findings = parseAuditFindings(report);
    expect(findings).toEqual([
      { file: 'a/SKILL.md', code: 'TOO_LONG', severity: 'warning', message: 'long' },
    ]);
  });

  it('attributes a finding with no file to the run, so it still reaches the gate', () => {
    const refused = 'status: findings\nfindings:\n  - severity: error\n    code: RESOURCE_CHECK_BROKEN\n    message: nothing examined\n';
    expect(parseAuditFindings(refused)).toEqual([
      { file: '<run>', code: 'RESOURCE_CHECK_BROKEN', severity: 'error', message: 'nothing examined' },
    ]);
  });

  // 🚨 The whole point of throwing here: a report this cannot read looks exactly
  // like a clean repository to a `length === 0` gate, so a shape change in the
  // command we ship would silently switch our own gate off.
  it('THROWS on a document with no status rather than reporting a clean repo', () => {
    expect(() => parseAuditFindings('findings: []')).toThrow(/status/);
  });

  it('THROWS on a run that did not finish, naming its refusal', () => {
    expect(() => parseAuditFindings('status: error\nfindings: []\nerror: { code: USAGE_INVALID, message: no }\n'))
      .toThrow(/did not finish.*USAGE_INVALID/);
  });

  it('THROWS when findings is not an array', () => {
    expect(() => parseAuditFindings('status: ok\nfindings: nope')).toThrow(/findings/);
  });

  it('THROWS on output that is not a YAML mapping at all', () => {
    expect(() => parseAuditFindings('just a string')).toThrow(/no YAML document/);
  });
});

/**
 * 🚨 The coercion these cover is the one that made the gate's own remedy the
 * delivery vehicle for a permanent bypass. `issues` was read as
 * `Array.isArray(x) ? x : []`, so a plausible shape change — findings grouped by
 * severity, say — parsed to ZERO findings. The gate then failed for the only
 * reason left, "N exemption(s) match nothing — delete them", a maintainer
 * followed that printed instruction, and the gate passed green forever over a
 * report it could no longer read. Every level is validated, never coerced.
 */
describe('parseAuditFindings — every level is validated, never coerced', () => {
  it('THROWS when `findings` is grouped into an object rather than a list', () => {
    const grouped = `
status: findings
findings:
  error:
    - code: REAL_DEFECT
      message: this must not vanish
`;
    expect(() => parseAuditFindings(grouped)).toThrow(/findings/);
  });

  it('THROWS when a finding is not a mapping', () => {
    expect(() => parseAuditFindings('status: findings\nfindings:\n  - just-a-string\n')).toThrow(/finding that is not a mapping/);
  });

  it('still accepts an empty findings list — a clean tree is not a shape change', () => {
    expect(parseAuditFindings('status: ok\nfindings: []\n')).toEqual([]);
  });
});

/**
 * The sibling half of the same defect: `main()` read `stdout` and never looked at
 * `error` or `status`. `spawnSync` reports a `maxBuffer` overrun as an ENOBUFS
 * `error` while still handing back the bytes it did collect, and a truncated
 * report parses — into FEWER findings — so an OOM-killed or clipped run read as a
 * CLEANER repository. The heap guard fixed in this same release fails closed on
 * `result.error`; this gate had copied the `maxBuffer` half and not the check.
 */
describe('auditRunFailure', () => {
  const ran = { status: 0, stdout: '---\nstatus: ok\nfindings: []\n' } as const;

  it('trusts a run that exited 0 with a document', () => {
    expect(auditRunFailure(ran)).toBeNull();
  });

  it('trusts a run that exited 1 — an error-severity finding is this gate\'s to judge, not a crash', () => {
    expect(auditRunFailure({ ...ran, status: 1 })).toBeNull();
  });

  it('refuses a spawn error even though bytes came back', () => {
    const truncated = { ...ran, error: new Error('spawnSync ENOBUFS') };
    expect(auditRunFailure(truncated)).toMatch(/ENOBUFS/);
  });

  it('refuses exit 2 — `vat audit` did not finish, so its output is not a verdict', () => {
    expect(auditRunFailure({ ...ran, status: 2 })).toMatch(/exited 2/);
  });

  it('refuses an empty document — the command did not run', () => {
    expect(auditRunFailure({ status: 0, stdout: '  \n' })).toMatch(/no output/);
  });
});
