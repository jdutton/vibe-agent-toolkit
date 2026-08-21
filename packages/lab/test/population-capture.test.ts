/**
 * Capturing a population, and the three things that make the row honest.
 *
 * 1. **`stable`** — a population is supposed to be deterministic, so two repeats
 *    that disagree are a finding about the subject rather than noise. The probe
 *    can be told to print a different document per invocation, which is the only
 *    way this assertion is not vacuous.
 * 2. **The git reference is taken at the DOCUMENT's stated root**, never at the
 *    subject directory. vat resolves a project root that may be an ancestor of
 *    the path it was handed, and every path in the document is relative to that
 *    root, so listing git anywhere else compares two different bases and renders
 *    the whole population as off-git.
 * 3. **A refusal is a failed row, never an empty one.** An empty population is a
 *    measurement; "we could not read one" is not, and the two must not render
 *    the same.
 */

import { setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { capturePopulation } from '../src/facets/population/capture.js';
import {
  POPULATION_FACET,
  POPULATION_FACET_VERSION,
  PopulationBodySchema,
  type PopulationCommandStats,
} from '../src/facets/population/types.js';
import type { CaptureRequest } from '../src/harness/types.js';

import { expectStamp, probeSubject } from './capture-fixtures.js';
import {
  cleanupProbes,
  PROBE_FAIL_TOKEN,
  PROBE_STDOUT_ENV,
  type Probe,
  setupProbe,
} from './command-probe.js';
import { commitAll, initRepo, writeFixtureFile } from './git-fixtures.js';

const CAPTURED_AT = '2026-08-17T00:00:00.000Z';
const SPEC = { name: 'population', args: ['scan'] } as const;

/** Content identities. Distinct, so a swap between two files is visible. */
const SUM_A = 'aaa';
const SUM_B = 'bbb';

/** Temp-directory prefix, so a stray probe directory names this suite. */
const PROBE_PREFIX = 'lab-population-';

const suite = setupSyncTempDirSuite('lab-population');

beforeAll(suite.beforeAll);
beforeEach(suite.beforeEach);
afterAll(async () => {
  await suite.afterAll();
  cleanupProbes();
});

/** A scan document over the given files, rooted where the caller says. */
function document(
  root: string,
  files: readonly { path: string; checksum: string }[],
  lane: string | null = 'walk',
): string {
  return JSON.stringify({
    status: 'success',
    root,
    ...(lane === null ? {} : { lane }),
    filesScanned: files.length,
    files,
  });
}

/**
 * Capture one command against a probe told to print the given documents.
 *
 * @param probe - The stand-in vat
 * @param outputs - One document per invocation, the last repeating
 * @param runs - Repeats to perform
 * @param args - Arguments, so a case can make the command fail
 * @returns The single command's row
 */
function captureRow(
  probe: Probe,
  outputs: readonly string[],
  runs = 2,
  args: readonly string[] = SPEC.args,
): PopulationCommandStats {
  const request: CaptureRequest = {
    instrument: probe.instrument,
    subject: probeSubject(probe.cwd, 'probe-subject', 'f'.repeat(64)),
    commands: [{ name: SPEC.name, args }],
    runs,
    cache: 'warm',
    env: { [PROBE_STDOUT_ENV]: JSON.stringify(outputs) },
    capturedAt: CAPTURED_AT,
  };
  const report = capturePopulation(request);

  expectStamp(report, {
    facet: POPULATION_FACET,
    facetVersion: POPULATION_FACET_VERSION,
    subject: request.subject,
    capturedAt: CAPTURED_AT,
  });
  expect(PopulationBodySchema.safeParse(report.body).success).toBe(true);

  const row = report.body.commands[0];
  expect(row).toBeDefined();
  return row as PopulationCommandStats;
}

describe('capturePopulation', () => {
  it('reports the enumerated set, sorted, with the lane the run declared', () => {
    const probe = setupProbe(PROBE_PREFIX);
    const output = document(probe.cwd, [
      { path: 'b.md', checksum: SUM_B },
      { path: 'a.md', checksum: SUM_A },
    ]);

    const row = captureRow(probe, [output]);

    expect(row.attribution).toBe('measured');
    expect(row.lane).toBe('walk');
    expect(row.count).toBe(2);
    expect(row.files.map((entry) => entry.path)).toEqual(['a.md', 'b.md']);
    expect(row.failed).toBe(false);
  });

  it('marks repeats that enumerated different sets as UNSTABLE', () => {
    const probe = setupProbe(PROBE_PREFIX);
    const first = document(probe.cwd, [{ path: 'a.md', checksum: SUM_A }]);
    const second = document(probe.cwd, [
      { path: 'a.md', checksum: SUM_A },
      { path: 'b.md', checksum: SUM_B },
    ]);

    const row = captureRow(probe, [first, second]);

    expect(row.stable).toBe(false);
  });

  it('reports stable when the repeats agreed, and null when only one ran', () => {
    const probe = setupProbe(PROBE_PREFIX);
    const output = document(probe.cwd, [{ path: 'a.md', checksum: SUM_A }]);

    expect(captureRow(probe, [output]).stable).toBe(true);
    // `null` is not `true`: a single repeat had nothing to disagree with.
    expect(captureRow(setupProbe(PROBE_PREFIX), [output], 1).stable).toBeNull();
  });

  it('calls an empty population "nothing-enumerated", not a failure and not measured', () => {
    const probe = setupProbe(PROBE_PREFIX);

    const row = captureRow(probe, [document(probe.cwd, [])]);

    expect(row.attribution).toBe('nothing-enumerated');
    expect(row.failed).toBe(false);
    expect(row.count).toBe(0);
  });

  it('fails the row — never empties it — when no population can be read', () => {
    const probe = setupProbe(PROBE_PREFIX);

    const row = captureRow(probe, ['not a document at all']);

    expect(row.failed).toBe(true);
    expect(row.attribution).toBe('not-measured');
    expect(row.failure).toContain('no JSON document');
    expect(row.files).toEqual([]);
  });

  it('fails the row when the repeats themselves failed, before reading any output', () => {
    const probe = setupProbe(PROBE_PREFIX);

    const row = captureRow(probe, [document(probe.cwd, [])], 2, [...SPEC.args, PROBE_FAIL_TOKEN]);

    expect(row.failed).toBe(true);
    expect(row.failure).toContain('repeats failed');
  });

  it('reports a null lane when the build did not say which enumerator ran', () => {
    const probe = setupProbe(PROBE_PREFIX);
    const output = document(probe.cwd, [{ path: 'a.md', checksum: SUM_A }], null);

    expect(captureRow(probe, [output]).lane).toBeNull();
  });

  it('takes the git reference at the DOCUMENT root, not at the subject directory', () => {
    // The probe's own directory is not a git repository. The document points at
    // one that is, and the reference has to follow the document — a capture that
    // listed git at the subject would report `gitTracked: null` here and, with
    // the roots the other way round, would report every enumerated path as
    // off-git.
    const repo = suite.getTempDir();
    initRepo(repo);
    writeFixtureFile(repo, 'tracked.md', 'committed\n');
    commitAll(repo, 'initial');

    const probe = setupProbe(PROBE_PREFIX);
    const output = document(repo, [
      { path: 'tracked.md', checksum: SUM_A },
      { path: 'never-committed.md', checksum: SUM_B },
    ]);

    const row = captureRow(probe, [output]);

    expect(row.root).toBe(repo);
    expect(row.gitTracked).toBe(1);
    expect(row.offGit).toEqual(['never-committed.md']);
  });

  it('reports no git reference — and no off-git findings — outside a repository', () => {
    const probe = setupProbe(PROBE_PREFIX);
    const output = document(probe.cwd, [{ path: 'a.md', checksum: SUM_A }]);

    const row = captureRow(probe, [output]);

    expect(row.gitTracked).toBeNull();
    // Not the whole population wearing the costume of a finding.
    expect(row.offGit).toEqual([]);
  });
});
