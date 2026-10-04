/**
 * `compareVerdict` over hand-built envelopes — pure, no spawn. The end-to-end
 * failability proof is the planted-delta integration suite; this file pins the
 * rules that need more than one alias to reach.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareVerdict, type VerdictComparison } from '../src/facets/verdict/compare.js';
import type { VerdictDeltas } from '../src/facets/verdict/deltas.js';
import { UNCODED_REFUSAL } from '../src/facets/verdict/extract.js';
import { type VerdictBody, VerdictBodySchema } from '../src/facets/verdict/types.js';

import { PROBE_VERSION } from './command-probe.js';
import { verdictDeltaEntryFactory } from './verdict-deltas-fixtures.js';

const ARM_A: InstrumentVersion = { ...PROBE_VERSION, closure: 'a'.repeat(64) };
const ARM_B: InstrumentVersion = { ...PROBE_VERSION, closure: 'b'.repeat(64) };
const ARM_C: InstrumentVersion = { ...PROBE_VERSION, closure: 'c'.repeat(64) };

/**
 * @param alias - The subject alias
 * @param instrument - The arm that captured it
 * @returns One envelope with one clean, measured row
 */
function envelope(alias: string, instrument: InstrumentVersion): ReportEnvelope<VerdictBody> {
  return {
    facet: 'verdict',
    coordinate: {
      subject: { id: alias, source: `/trees/${alias}` },
      subjectVersion: { kind: 'snapshot', fingerprint: `fp-${alias}`, fileCount: 1 },
      instrument,
    },
    capturedAt: '2026-09-28T00:00:00.000Z',
    body: {
      arm: { set: {}, unset: [] },
      rows: [
        {
          name: 'audit',
          argv: ['audit', `/trees/${alias}`],
          outcome: 'exited',
          exitCode: 0,
          spawnError: null,
          document: 'status: success\n',
        },
      ],
      excluded: [],
    },
  };
}

const OPTIONS = {
  control: false,
  deltas: { baseline: PROBE_VERSION.version, deltas: [] },
  changelog: new Map<string, string>(),
};

describe('compareVerdict — one side is one arm', () => {
  it('compares two aliases captured by one arm per side (positive control)', () => {
    const result = compareVerdict(
      [envelope('crucible-1', ARM_A), envelope('crucible-2', ARM_A)],
      [envelope('crucible-1', ARM_B), envelope('crucible-2', ARM_B)],
      OPTIONS,
    );

    expect(result).toMatchObject({ ok: true, exitCode: ExitCode.OK });
  });

  it('refuses a baseline whose envelopes carry different instruments', () => {
    const result = compareVerdict(
      [envelope('crucible-1', ARM_A), envelope('crucible-2', ARM_C)],
      [envelope('crucible-1', ARM_B), envelope('crucible-2', ARM_B)],
      OPTIONS,
    );

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('the baseline mixes two arms') });
  });

  it('refuses a candidate whose envelopes carry different instruments', () => {
    const result = compareVerdict(
      [envelope('crucible-1', ARM_A), envelope('crucible-2', ARM_A)],
      [envelope('crucible-1', ARM_B), envelope('crucible-2', ARM_C)],
      OPTIONS,
    );

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('the candidate mixes two arms') });
  });
});

/** A resources-validate row whose stdout holds one broken-link finding in `docs/a.md`. */
const FINDING_DOCUMENT = JSON.stringify({
  status: 'findings',
  examined: 1,
  findings: [{ code: 'LINK_BROKEN_FILE', severity: 'error', message: 'gone', location: 'docs/a.md' }],
  summary: { errors: 1, warnings: 0, info: 0 },
  data: {},
});

/** One alias's envelope with one row, its document as given. */
function withDocument(instrument: InstrumentVersion, document: string, exitCode: number): ReportEnvelope<VerdictBody> {
  const base = envelope('crucible-1', instrument);
  const [row] = base.body.rows;
  if (row === undefined) throw new Error('fixture has one row');
  return { ...base, body: { ...base.body, rows: [{ ...row, name: 'resources-validate', exitCode, document }] } };
}

describe('compareVerdict — the verdict is derived from the stored document', () => {
  it('reads the finding a document holds, whatever an older capture believed about it', () => {
    // The baseline's document is clean; the candidate's holds a finding. The
    // comparison is the CURRENT extractor over each stored document — a
    // verdict baked in by an older lab build is not an input to it.
    const result = compareVerdict(
      [withDocument(ARM_A, 'status: success\n', 0)],
      [withDocument(ARM_B, FINDING_DOCUMENT, 1)],
      OPTIONS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.undeclared.map((delta) => delta.change.kind);
    expect(kinds).toContain('finding-added');
  });

  it('refuses to read a capture that still carries a stored verdict, rather than trust it', () => {
    // Pre-1.0, no compatibility: a capture from a lab build that stored a
    // verdict is refused loudly by the strict schema, never half-read.
    const [row] = envelope('crucible-1', ARM_A).body.rows;
    const stale = { arm: { set: {}, unset: [] }, rows: [{ ...row, verdict: { exitCode: 0, shape: 'legacy', findings: [] } }] };

    expect(VerdictBodySchema.safeParse(stale).success).toBe(false);
  });
});

/**
 * A legacy composite document: one finding itemized (`ALLOW_UNUSED`), two only
 * tallied — by code, and by severity (one info, one warning).
 */
const TALLIED_DOCUMENT = [
  'status: error',
  'phases:',
  '  - name: skills',
  '    issueCounts:',
  '      errors: 0',
  '      warnings: 2',
  '      info: 1',
  '    report:',
  '      results:',
  '        - skillName: one',
  '          info: 1',
  '          warnings: 1',
  '          codes:',
  '            LINK_DROPPED_BY_DEPTH: 2',
  '      runIssues:',
  '        - severity: warning',
  '          code: ALLOW_UNUSED',
  '',
].join('\n');

/** One finding of a report document: code, severity, and a location or none. */
type Listed = readonly [code: string, severity: string, location: string | null];

/** The one phase of {@link TALLIED_DOCUMENT}, as a report publishes it: the same severity counts. */
const SAME_PHASES = { phases: [{ name: 'skills', summary: { errors: 0, warnings: 2, info: 1 } }] };

/**
 * @param listed - The findings
 * @param data - The report's `data`; the phase counts {@link TALLIED_DOCUMENT} published unless given
 * @returns A report document itemizing them
 */
function itemizedDocument(listed: readonly Listed[], data: Record<string, unknown> = SAME_PHASES): string {
  return JSON.stringify({
    status: 'findings',
    examined: 1,
    findings: listed.map(([code, severity, location]) => ({ code, severity, message: 'm', ...(location === null ? {} : { location }) })),
    summary: { errors: 0, warnings: listed.length, info: 0 },
    data,
  });
}

const ALLOW_UNUSED: Listed = ['ALLOW_UNUSED', 'warning', null];
const DROPPED_INFO: Listed = ['LINK_DROPPED_BY_DEPTH', 'info', 'skills/one/SKILL.md'];
const DROPPED_WARNING: Listed = ['LINK_DROPPED_BY_DEPTH', 'warning', 'skills/one/SKILL.md'];

/** The candidate that itemizes exactly what {@link TALLIED_DOCUMENT} published. */
const SAME_ITEMIZED: readonly Listed[] = [ALLOW_UNUSED, DROPPED_INFO, DROPPED_WARNING];

/**
 * @param before - The baseline document
 * @param after - The candidate document
 * @returns Every delta the one row shows, in words: the kind, plus the code of a finding
 */
function observedChanges(before: string, after: string): string[] {
  const result = compareVerdict([withDocument(ARM_A, before, 1)], [withDocument(ARM_B, after, 1)], OPTIONS);
  if (!result.ok) throw new Error(result.refusal);
  return result.undeclared.map(({ change }) =>
    change.kind === 'finding-added' || change.kind === 'finding-removed' ? `${change.kind} ${change.finding.code}` : change.kind,
  );
}

describe('compareVerdict — findings the baseline only tallied', () => {
  it('observes ONE findings-itemized delta when the candidate itemizes exactly the tallies', () => {
    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument(SAME_ITEMIZED))).toEqual(['findings-itemized', 'document']);
  });

  it('observes each finding when the candidate adds one beyond the tallies', () => {
    const extra: Listed = ['LINK_DROPPED_BY_DEPTH', 'info', 'skills/one/other.md'];

    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument([...SAME_ITEMIZED, extra]))).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });

  it('observes each finding when the candidate loses one the baseline tallied', () => {
    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument([ALLOW_UNUSED, DROPPED_INFO]))).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });

  // The per-code count still matches (two), so only the severity margin can see this.
  it('observes each finding when a tallied finding changed severity', () => {
    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument([ALLOW_UNUSED, DROPPED_INFO, DROPPED_INFO]))).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });

  it('still observes, one by one, a finding whose code the baseline never tallied', () => {
    const fresh: Listed = ['FILES_CONFIG_DEST_MISSING', 'error', 'dist/skills/one/a.bin'];

    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument([...SAME_ITEMIZED, fresh]))).toEqual([
      'findings-itemized',
      'finding-added FILES_CONFIG_DEST_MISSING',
      'document',
    ]);
  });

  it('still compares the findings the baseline itemized by identity — a moved one is added and removed', () => {
    const moved: Listed = ['ALLOW_UNUSED', 'warning', 'config'];

    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument([moved, DROPPED_INFO, DROPPED_WARNING]))).toEqual([
      'findings-itemized',
      'finding-added ALLOW_UNUSED',
      'finding-removed ALLOW_UNUSED',
      'document',
    ]);
  });

  // The count for the code still matches (two added, two tallied), but one the
  // baseline itemized is gone — "exactly the tallies, none removed" is false.
  it('observes each finding when a finding with a tallied code was removed', () => {
    const before = TALLIED_DOCUMENT.replace('code: ALLOW_UNUSED', 'code: LINK_DROPPED_BY_DEPTH');

    expect(observedChanges(before, itemizedDocument([DROPPED_INFO, DROPPED_WARNING]))).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-removed LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });

  // M1: an arm that still tallies has itemized nothing — the counts the rule
  // would match are not all on the page.
  it('never calls it "itemized" when the candidate tallies too', () => {
    const stillTallying = itemizedDocument(SAME_ITEMIZED, {
      ...SAME_PHASES,
      skills: [{ skillName: 'two', info: 1, codes: { LINK_DROPPED_BY_DEPTH: 1 } }],
    });
    expect(observedChanges(TALLIED_DOCUMENT, itemizedDocument(SAME_ITEMIZED))).toContain('findings-itemized'); // positive control

    expect(observedChanges(TALLIED_DOCUMENT, stillTallying)).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });

  // M3: both arms publish a severity count per phase. A finding that moved to
  // another phase keeps its code and severity, so only this margin can see it.
  it('observes each finding when a phase that tallied publishes different severity counts in the candidate', () => {
    const phased = (skills: number, other: number): string =>
      itemizedDocument(SAME_ITEMIZED, {
        phases: [
          { name: 'skills', summary: { errors: 0, warnings: skills, info: 1 } },
          { name: 'other', summary: { errors: 0, warnings: other, info: 0 } },
        ],
      });

    expect(observedChanges(TALLIED_DOCUMENT, phased(2, 0))).toEqual(['findings-itemized', 'document']); // positive control
    expect(observedChanges(TALLIED_DOCUMENT, phased(1, 1))).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });

  it('never calls two itemizing documents "itemized" — with no tally there is nothing to itemize', () => {
    expect(observedChanges(itemizedDocument([ALLOW_UNUSED]), itemizedDocument(SAME_ITEMIZED))).toEqual([
      'finding-added LINK_DROPPED_BY_DEPTH',
      'finding-added LINK_DROPPED_BY_DEPTH',
      'document',
    ]);
  });
});

const EXCLUSION_REASON = 'needs an artifact the subject has not built';

/** A report-shaped refusal document carrying `code`, as a wave-A build prints it. */
function refusalDocument(code: string): string {
  return JSON.stringify({
    status: 'error',
    examined: 0,
    findings: [],
    summary: { errors: 0, warnings: 0, info: 0 },
    error: { code, message: 'm' },
    data: null,
  });
}

/** What an excluded verb's row did in one arm: the fields of the row that vary. */
type Probe = Pick<VerdictBody['rows'][number], 'outcome' | 'exitCode' | 'spawnError' | 'document'>;

/** The refusal an exclusion expects: exit 2, with an older build's refusal document — a sentence, no code. */
const EXIT_2: Probe = { outcome: 'exited', exitCode: 2, spawnError: null, document: 'status: system-error\nerror: the build stopped\n' };
/** Exit 2 and nothing a refusal could be read from: what Commander prints for an unknown option. */
const EXIT_2_SILENT: Probe = { ...EXIT_2, document: '' };
/** Exit 2 again, with a coded refusal. */
const EXIT_2_CODED: Probe = { ...EXIT_2, document: refusalDocument('RUN_INCOMPLETE') };
const MEASURED: Probe = { outcome: 'exited', exitCode: 0, spawnError: null, document: 'status: success\n' };

/**
 * @param instrument - The arm
 * @param probe - What the excluded `build` row did in that arm
 * @param reason - Its exclusion's reason, or `null` for no exclusion (and no `build` row)
 * @returns An envelope whose `build` verb the subjects file excluded
 */
function excluding(instrument: InstrumentVersion, probe: Probe, reason: string | null = EXCLUSION_REASON): ReportEnvelope<VerdictBody> {
  const base = envelope('crucible-1', instrument);
  if (reason === null) return base;
  const build = { name: 'build', argv: ['build'], ...probe };
  return { ...base, body: { ...base.body, rows: [...base.body.rows, build], excluded: [{ name: 'build', reason }] } };
}

/**
 * @param before - The baseline's `build` row
 * @param after - The candidate's
 * @param deltas - Declared entries, none unless given
 * @returns The comparison of two captures that both exclude `build`
 */
function compareExcluded(before: Probe, after: Probe, deltas: VerdictDeltas['deltas'] = []): VerdictComparison {
  const result = compareVerdict([excluding(ARM_A, before)], [excluding(ARM_B, after)], {
    ...OPTIONS,
    deltas: { baseline: PROBE_VERSION.version, deltas },
    changelog: new Map([['CHANGELOG.md', '- A change.\n  <!-- verdict-delta:a-change -->\n']]),
  });
  if (!result.ok) throw new Error(result.refusal);
  return result;
}

/** A deltas entry on the excluded `build` row. */
const declareOnBuild = verdictDeltaEntryFactory({
  subject: 'crucible-1',
  verb: 'build',
  changelog: 'CHANGELOG.md#a-change',
  reason: 'a declared change on the excluded row',
});

/** @returns Every undeclared delta of a comparison, in words */
function undeclaredOf(comparison: VerdictComparison): string[] {
  return comparison.undeclared.map(({ verb, change }) => {
    const what = change.kind === 'exit' ? `exit ${String(change.from)}→${String(change.to)}` : change.kind;
    return `${verb}: ${what}`;
  });
}

describe('compareVerdict — an exclusion pins a published refusal at exit 2 in both arms, and hides nothing else', () => {
  it('names an exclusion that held — a refusal at exit 2 in both arms — with what each arm published, and no UNMEASURED delta', () => {
    const result = compareExcluded(EXIT_2, EXIT_2);

    expect(result).toMatchObject({
      exitCode: ExitCode.OK,
      undeclared: [],
      staleExclusions: [],
      excluded: [
        {
          subject: 'crucible-1',
          verb: 'build',
          reason: EXCLUSION_REASON,
          detail: [`baseline: exit 2, refusal ${UNCODED_REFUSAL}`, `candidate: exit 2, refusal ${UNCODED_REFUSAL}`],
        },
      ],
    });
    // Still a compared row: its exit code and refusal are data.
    expect(result.rows.map((row) => row.verb)).toEqual(['audit', 'build']);
  });

  // C1: two unmeasured arms that DIFFER. None of these is "exit 2", so none is
  // what the exclusion claims, and each must surface exactly as it would on a
  // row nobody excluded.
  it.each<[string, Probe, string[]]>([
    ['crashed (exit 1, empty stdout)', { outcome: 'exited', exitCode: 1, spawnError: null, document: '' }, ['build: exit 2→1', 'build: refusal', 'build: unmeasured']],
    ['exited 0 with unparseable stdout', { outcome: 'exited', exitCode: 0, spawnError: null, document: 'not: [yaml' }, ['build: exit 2→0', 'build: refusal', 'build: unmeasured']],
    ['exited 1 with unparseable stdout', { outcome: 'exited', exitCode: 1, spawnError: null, document: 'not: [yaml' }, ['build: exit 2→1', 'build: refusal', 'build: unmeasured']],
    ['hung (not run)', { outcome: 'not-run', exitCode: null, spawnError: 'ETIMEDOUT', document: '' }, ['build: refusal', 'build: unmeasured']],
    ['measured it (exit 0, readable)', MEASURED, ['build: exit 2→0', 'build: refusal', 'build: unmeasured']],
  ])('FAILS when the candidate %s', (_what, candidate, expected) => {
    const result = compareExcluded(EXIT_2, candidate);

    expect(result.exitCode).toBe(ExitCode.FINDINGS);
    expect(undeclaredOf(result)).toEqual(expected);
    expect(result.excluded).toEqual([]);
  });

  // N1: exit 2 alone is not a refusal. An arm that exits 2 and publishes no
  // refusal the lab can read is unmeasured some OTHER way, in a control too.
  it.each<[string, Probe, Probe, string[]]>([
    ['the candidate exits 2 with empty stdout', EXIT_2, EXIT_2_SILENT, ['build: refusal', 'build: unmeasured']],
    ['the candidate exits 2 with unparseable stdout', EXIT_2, { ...EXIT_2, document: 'not: [yaml' }, ['build: refusal', 'build: unmeasured']],
    ['the baseline exits 2 with empty stdout', EXIT_2_SILENT, EXIT_2, ['build: refusal', 'build: unmeasured']],
    ['BOTH arms exit 2 with empty stdout', EXIT_2_SILENT, EXIT_2_SILENT, ['build: unmeasured']],
    ['both arms exit 2 with a parsed document that refuses nothing', { ...EXIT_2, document: 'status: success\n' }, { ...EXIT_2, document: 'status: success\n' }, ['build: unmeasured']],
  ])('FAILS when %s', (_what, baseline, candidate, expected) => {
    const result = compareExcluded(baseline, candidate);

    expect(result.exitCode).toBe(ExitCode.FINDINGS);
    expect(undeclaredOf(result)).toEqual(expected);
    expect(result.excluded).toEqual([]);
  });

  it('FAILS when both arms are unmeasured the same way, but not by exiting 2', () => {
    const hung: Probe = { outcome: 'not-run', exitCode: null, spawnError: 'ETIMEDOUT', document: '' };
    const result = compareExcluded(hung, hung);

    expect(result.exitCode).toBe(ExitCode.FINDINGS);
    expect(undeclaredOf(result)).toEqual(['build: unmeasured']);
  });

  it('FAILS when both arms exit 2 with a different refusal code, and passes once that is declared', () => {
    const undeclared = compareExcluded(EXIT_2, EXIT_2_CODED);
    expect(undeclared.exitCode).toBe(ExitCode.FINDINGS);
    expect(undeclared.undeclared.map((delta) => delta.change)).toEqual([{ kind: 'refusal', from: [UNCODED_REFUSAL], to: ['RUN_INCOMPLETE'] }]);
    // Held (exit 2 in both arms), and still visible: the candidate's code is on the EXCLUDED line.
    expect(undeclared.excluded[0]?.detail).toEqual([`baseline: exit 2, refusal ${UNCODED_REFUSAL}`, 'candidate: exit 2, refusal RUN_INCOMPLETE']);

    const declared = compareExcluded(EXIT_2, EXIT_2_CODED, [declareOnBuild({ refusal: { from: [UNCODED_REFUSAL], to: ['RUN_INCOMPLETE'] } })]);
    expect(declared).toMatchObject({ exitCode: ExitCode.OK, undeclared: [], unused: [] });

    const wrong = compareExcluded(EXIT_2, EXIT_2_CODED, [declareOnBuild({ refusal: { from: [UNCODED_REFUSAL], to: ['INTERNAL_ERROR'] } })]);
    expect(wrong.exitCode).toBe(ExitCode.FINDINGS);
    expect(wrong.unused).toHaveLength(1);
  });

  // M6: once the tree can complete the verb, the move is declarable in the
  // committed deltas file — control (exit 2 twice) and compare can both pass.
  it('lets a verb the candidate now completes be DECLARED, so a control and a compare can both pass', () => {
    const declared = compareExcluded(EXIT_2, MEASURED, [
      declareOnBuild({ exit: { from: 2, to: 0 }, refusal: { from: [UNCODED_REFUSAL], to: [] }, unmeasured: true }),
    ]);

    expect(declared).toMatchObject({ exitCode: ExitCode.OK, undeclared: [], unused: [], staleExclusions: [] });
    expect(compareExcluded(EXIT_2, EXIT_2)).toMatchObject({ exitCode: ExitCode.OK });
  });

  it('FAILS, undeclarably, when BOTH arms measured the excluded verb — the exclusion excludes nothing', () => {
    const result = compareExcluded(MEASURED, MEASURED);

    expect(result).toMatchObject({ exitCode: ExitCode.FINDINGS, undeclared: [], excluded: [] });
    expect(result.staleExclusions.map((row) => row.verb)).toEqual(['build']);
  });

  it('applies the same refusal layer to a row nobody excluded', () => {
    const plain = (instrument: InstrumentVersion, probe: Probe): ReportEnvelope<VerdictBody> => {
      const excluded = excluding(instrument, probe);
      return { ...excluded, body: { ...excluded.body, excluded: [] } };
    };
    const result = compareVerdict([plain(ARM_A, EXIT_2)], [plain(ARM_B, EXIT_2_CODED)], OPTIONS);

    expect(result.ok && result.undeclared.map((delta) => delta.change.kind)).toEqual(['refusal', 'unmeasured']);
  });

  it('refuses two captures that exclude different verbs', () => {
    const result = compareVerdict([excluding(ARM_A, EXIT_2)], [excluding(ARM_B, EXIT_2, null)], OPTIONS);

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('excludes different verbs') });
  });

  it('refuses a stored body whose exclusion names no row — an excluded verb nobody ran', () => {
    const { body } = excluding(ARM_A, EXIT_2);
    expect(VerdictBodySchema.safeParse(body).success).toBe(true); // positive control

    const hidden = { ...body, rows: body.rows.filter((row) => row.name !== 'build') };
    expect(VerdictBodySchema.safeParse(hidden).success).toBe(false);
    expect(compareVerdict([{ ...excluding(ARM_A, EXIT_2), body: hidden }], [{ ...excluding(ARM_B, EXIT_2), body: hidden }], OPTIONS))
      .toMatchObject({ ok: false, refusal: expect.stringContaining('holds no row for it') });
  });
});
