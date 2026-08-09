/**
 * Unit tests for the snapshot comparison.
 *
 * The load-bearing one is `pins the blind spot in the cheap line counter`: the
 * counter is an order-insensitive multiset difference, so a pure reordering
 * counts 0/0 while the texts differ. Status must therefore come from string
 * equality. Without that test, a future change could quietly start deriving
 * status from the counts and every reordering would report as `same` — a
 * confidently wrong "nothing changed", which is the one failure mode this whole
 * instrument exists to avoid.
 */

import { describe, expect, it } from 'vitest';

import {
  compareSnapshots,
  countLineDelta,
  extractHeaderFacts,
  headlineChanges,
  renderUnifiedDiff,
} from '../../src/qa-snapshot/diff.js';
import { renderCompareSummary } from '../../src/qa-snapshot/render.js';
import {
  SNAPSHOT_FORMAT_VERSION,
  type ArtifactDelta,
  type CompareReport,
  type LoadedSnapshot,
  type SnapshotManifest,
} from '../../src/qa-snapshot/types.js';

const BEFORE_DIR = '/snapshots/before';
const AFTER_DIR = '/snapshots/after';
const CORPUS_ROOT = '/workspaces/vibe-agent-toolkit';
const LANE_ARTIFACT = 'oracle/enumeration-resources.txt';
const PARSE_ARTIFACT = 'oracle/parse-facts.txt';
const LANE_SELECTOR = 'enumeration.resources';
const DOC_A_ROW = '0\tdocs/a.md';
const DOC_B_ROW = '1\tdocs/b.md';

/** A content key as `content-key.ts` renders it — no schema version in it. */
const CONTENT_KEY = 'markdown.deadbeef12345678';

/** Only what a test actually varies; everything else gets a fixed default. */
interface SnapshotOverrides {
  dir?: string;
  formatVersion?: number;
  cacheNamespace?: string;
  platform?: string;
  corpusRoot?: string;
  parseFactArtifact?: string | null;
  artifacts?: Readonly<Record<string, string>>;
}

/**
 * Build a `LoadedSnapshot` with one lane and no commands.
 *
 * @param overrides - The fields this test is about
 * @returns A loaded snapshot
 */
function loadedSnapshot(overrides: SnapshotOverrides = {}): LoadedSnapshot {
  const manifest: SnapshotManifest = {
    formatVersion: overrides.formatVersion ?? SNAPSHOT_FORMAT_VERSION,
    vatVersion: '0.1.42',
    cacheNamespace: overrides.cacheNamespace ?? '0.1.42',
    capturedAtIso: '2026-08-08T00:00:00.000Z',
    corpusRoot: overrides.corpusRoot ?? CORPUS_ROOT,
    corpusLabel: 'vat',
    platform: overrides.platform ?? 'darwin',
    nodeVersion: 'v22.11.0',
    corpusGitHead: 'abc1234',
    corpusGitDirty: false,
    lanes: [
      {
        laneId: 'resources',
        artifact: LANE_ARTIFACT,
        route: 'git-ls-files',
        orderPortable: true,
        enumeratedCount: 2,
        admittedCount: 2,
        collisionCount: 0,
        restatementDriftCount: 0,
        buildError: null,
      },
    ],
    commands: [],
    parseFactArtifact: overrides.parseFactArtifact ?? null,
    parseFactBlobCount: null,
    parseFactKeyDisagreementCount: null,
    warnings: [],
  };

  return {
    dir: overrides.dir ?? BEFORE_DIR,
    manifest,
    artifacts: new Map(Object.entries(overrides.artifacts ?? {})),
  };
}

/**
 * Compare two snapshots that differ only in the artifacts and the overrides given.
 *
 * @param beforeArtifacts - Artifact map for the earlier side
 * @param afterArtifacts - Artifact map for the later side
 * @param beforeOverrides - Manifest overrides for the earlier side
 * @param afterOverrides - Manifest overrides for the later side
 * @returns The comparison report
 */
function comparePair(
  beforeArtifacts: Readonly<Record<string, string>>,
  afterArtifacts: Readonly<Record<string, string>>,
  beforeOverrides: SnapshotOverrides = {},
  afterOverrides: SnapshotOverrides = {},
): CompareReport {
  return compareSnapshots(
    loadedSnapshot({ ...beforeOverrides, dir: BEFORE_DIR, artifacts: beforeArtifacts }),
    loadedSnapshot({ ...afterOverrides, dir: AFTER_DIR, artifacts: afterArtifacts }),
  );
}

/**
 * Enumeration-oracle text with the header the real renderer emits.
 *
 * @param enumeratedCount - Value for the `enumeratedCount` header line
 * @param body - Rows after the header's terminating blank line
 * @returns Artifact text, LF-terminated
 */
function oracleText(enumeratedCount: number, body: readonly string[]): string {
  return [
    '# enumeration-snapshot',
    'lane: resources',
    `enumeratedCount: ${String(enumeratedCount)}`,
    '',
    '## enumerated (ordered, pre-deduplication)',
    ...body,
    '',
  ].join('\n');
}

/**
 * Find one row of a report by its selector.
 *
 * @param report - The comparison
 * @param name - The selector to look up
 * @returns The matching row
 */
function rowFor(report: CompareReport, name: string): ArtifactDelta {
  const delta = report.deltas.find((candidate) => candidate.name === name);
  if (delta === undefined) {
    throw new Error(`no delta named ${name}`);
  }
  return delta;
}

describe('countLineDelta', () => {
  it('counts an inserted line as added and nothing as removed', () => {
    expect(countLineDelta('a\nb', 'a\nx\nb')).toEqual({ addedLines: 1, removedLines: 0 });
  });

  it('counts a deleted line as removed and nothing as added', () => {
    expect(countLineDelta('a\nx\nb', 'a\nb')).toEqual({ addedLines: 0, removedLines: 1 });
  });

  it('counts a modified line as one added and one removed', () => {
    expect(countLineDelta('a\nb\nc', 'a\nB\nc')).toEqual({ addedLines: 1, removedLines: 1 });
  });

  it('counts a repeated line by multiplicity, not by presence', () => {
    expect(countLineDelta('a\na\na', 'a')).toEqual({ addedLines: 0, removedLines: 2 });
  });
});

describe('the blind spot in the cheap line counter', () => {
  const rows = [DOC_A_ROW, DOC_B_ROW];
  const reordered = [DOC_B_ROW, DOC_A_ROW];

  it('reports 0/0 for a pure reordering even though the texts differ', () => {
    const before = oracleText(2, rows);
    const after = oracleText(2, reordered);

    expect(before).not.toBe(after);
    expect(countLineDelta(before, after)).toEqual({ addedLines: 0, removedLines: 0 });
  });

  it('still marks a pure reordering as changed, because status comes from string equality', () => {
    const report = comparePair(
      { [LANE_ARTIFACT]: oracleText(2, rows) },
      { [LANE_ARTIFACT]: oracleText(2, reordered) },
    );

    const delta = rowFor(report, LANE_SELECTOR);
    expect(delta.status).toBe('changed');
    expect(delta.addedLines).toBe(0);
    expect(delta.removedLines).toBe(0);
    expect(report.changedCount).toBe(1);
  });
});

describe('extractHeaderFacts', () => {
  it('stops at the first blank line and ignores a key/value in a body row', () => {
    const facts = extractHeaderFacts(oracleText(265, ['bodyKey: not-a-header']), 'oracle');

    expect(facts.get('lane')).toBe('resources');
    expect(facts.get('enumeratedCount')).toBe('265');
    expect(facts.has('bodyKey')).toBe(false);
  });

  it('reads indent-0 scalars from a YAML capture and skips containers', () => {
    const yaml = ['status: success', 'filesScanned: 1041', 'findings:', '  - code: X', ''].join('\n');
    const facts = extractHeaderFacts(yaml, 'command');

    expect(facts.get('status')).toBe('success');
    expect(facts.get('filesScanned')).toBe('1041');
    expect(facts.has('findings')).toBe(false);
    expect(facts.has('code')).toBe(false);
  });

  it('reads indent-2 scalars from a JSON capture, unquoting the value', () => {
    const json = ['{', '  "status": "success",', '  "linksFound": 8123,', '  "errors": [', '    {', ''].join('\n');
    const facts = extractHeaderFacts(json, 'command');

    expect(facts.get('status')).toBe('success');
    expect(facts.get('linksFound')).toBe('8123');
    expect(facts.has('errors')).toBe(false);
  });
});

describe('headlineChanges', () => {
  it('reports only the keys whose value moved, as name before→after', () => {
    expect(headlineChanges(oracleText(265, []), oracleText(267, []), 'oracle')).toEqual([
      'enumeratedCount 265→267',
    ]);
  });

  it('reports nothing when every header value held', () => {
    expect(headlineChanges(oracleText(265, ['x']), oracleText(265, ['y']), 'oracle')).toEqual([]);
  });
});

describe('compareSnapshots constraints', () => {
  it('compares content keys directly across builds — there is nothing to mask', () => {
    // Keys no longer carry a schema version, so the same bytes key identically
    // under any build of VAT. A key that DOES move is therefore real signal,
    // and must show up as a change rather than being masked away.
    const parseBefore = ['# parse-fact-snapshot', 'blobCount: 1', '', `## blob ${CONTENT_KEY}`, ''].join('\n');
    const parseAfter = ['# parse-fact-snapshot', 'blobCount: 1', '', '## blob markdown.0123456789abcdef', ''].join('\n');
    const lane = oracleText(2, [DOC_A_ROW]);

    const report = comparePair(
      { [LANE_ARTIFACT]: lane, [PARSE_ARTIFACT]: parseBefore },
      { [LANE_ARTIFACT]: lane, [PARSE_ARTIFACT]: parseAfter },
      { cacheNamespace: '0.1.42', parseFactArtifact: PARSE_ARTIFACT },
      { cacheNamespace: '0.1.43-dev-abc123', parseFactArtifact: PARSE_ARTIFACT },
    );

    expect(rowFor(report, 'parse-facts').status).toBe('changed');
    expect(report.constraints.some((note) => note.startsWith('MASKED:'))).toBe(false);
  });

  it('refuses across format versions, returning no deltas and a stated reason', () => {
    const report = comparePair(
      { [LANE_ARTIFACT]: oracleText(2, []) },
      { [LANE_ARTIFACT]: oracleText(9, []) },
      { formatVersion: 1 },
      { formatVersion: 2 },
    );

    expect(report.deltas).toEqual([]);
    expect(report.changedCount).toBe(0);
    expect(report.constraints).toHaveLength(1);
    expect(report.constraints[0]).toContain('REFUSED');
  });

  it('states that a different corpus root may make the snapshots incomparable', () => {
    const report = comparePair(
      { [LANE_ARTIFACT]: oracleText(2, []) },
      { [LANE_ARTIFACT]: oracleText(2, []) },
      { corpusRoot: CORPUS_ROOT },
      { corpusRoot: '/workspaces/some-other-repo' },
    );

    expect(report.constraints.some((note) => note.startsWith('CORPUS:'))).toBe(true);
  });

  it('names an artifact present on one side only', () => {
    const report = comparePair({ [LANE_ARTIFACT]: oracleText(2, []) }, {});

    expect(rowFor(report, LANE_SELECTOR).status).toBe('removed');
    expect(report.constraints.some((note) => note.startsWith('REMOVED:'))).toBe(true);
  });
});

describe('renderUnifiedDiff', () => {
  it('emits a hunk header and the changed lines when the diff fits', () => {
    const result = renderUnifiedDiff('a\nb\nc', 'a\nB\nc', { maxLines: 50, context: 1 });

    expect(result.truncated).toBe(false);
    expect(result.totalHunks).toBe(1);
    expect(result.text).toContain('@@');
    expect(result.text).toContain('-b');
    expect(result.text).toContain('+B');
  });

  it('sets truncated and states the cap rather than silently cutting the text', () => {
    const before = Array.from({ length: 30 }, (_, index) => `old-${String(index)}`).join('\n');
    const after = Array.from({ length: 30 }, (_, index) => `new-${String(index)}`).join('\n');

    const result = renderUnifiedDiff(before, after, { maxLines: 5, context: 0 });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('TRUNCATED');
    expect(result.text).toContain('of 61 diff lines');
  });

  it('names the real bail reason when it is the table budget, not the line budget', () => {
    const before = Array.from({ length: 3000 }, (_, index) => `old-${String(index)}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, index) => `new-${String(index)}`).join('\n');

    const result = renderUnifiedDiff(before, after, { maxLines: 6, context: 1 });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('POSITIONAL');
    expect(result.text).not.toContain('20000-line');
  });
});

describe('renderCompareSummary', () => {
  it('collapses an all-identical report to a few lines that name no artifact', () => {
    const lane = oracleText(2, [DOC_A_ROW]);
    const report = comparePair({ [LANE_ARTIFACT]: lane }, { [LANE_ARTIFACT]: lane });

    const lines = renderCompareSummary(report).trimEnd().split('\n');

    expect(report.changedCount).toBe(0);
    expect(lines.length).toBeLessThan(12);
    expect(lines.join('\n')).not.toContain(LANE_SELECTOR);
    expect(lines.join('\n')).toContain('All 1 artifacts identical.');
  });

  it('shows a table with counts and a detail hint once something moved', () => {
    const report = comparePair(
      { [LANE_ARTIFACT]: oracleText(265, [DOC_A_ROW]) },
      { [LANE_ARTIFACT]: oracleText(267, [DOC_A_ROW, DOC_B_ROW]) },
    );

    const text = renderCompareSummary(report);

    expect(text).toContain('artifact');
    expect(text).toContain(LANE_SELECTOR);
    expect(text).toContain('enumeratedCount 265→267');
    expect(text).toContain('1 of 1 artifacts changed.');
    expect(text).toContain(`--detail ${LANE_SELECTOR}`);
  });
});
