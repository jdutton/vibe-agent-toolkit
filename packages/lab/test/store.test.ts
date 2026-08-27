/**
 * Storage has one job beyond round-tripping: **two reports that differ on any
 * axis must land on different filenames.** A naming scheme that collapses two
 * coordinates onto one name silently overwrites one measurement with another,
 * and the loss is invisible — the surviving file looks perfectly well-formed.
 * The distinctness tests below are the real content here.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { readReport, reportFileName, writeReport } from '../src/store.js';

import { COORDINATE, makeReport as report, makeReportAt as reportAt } from './report-fixtures.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-store-'));
});

describe('reportFileName', () => {
  it('gives one coordinate one stable name', () => {
    expect(reportFileName(report())).toBe(reportFileName(report()));
  });

  it('separates reports that differ only by facet', () => {
    expect(reportFileName(report())).not.toBe(reportFileName(report({ facet: 'io' })));
  });

  it('separates reports that differ only by subject', () => {
    const other = reportAt({ subject: { id: 'other-skills', source: 'https://example/o.git' } });
    expect(reportFileName(report())).not.toBe(reportFileName(other));
  });

  it('separates reports that differ only by subject version', () => {
    const other = reportAt({ subjectVersion: { kind: 'git', commit: 'b'.repeat(40), ref: 'main', dirty: false, workingFingerprint: null } });
    expect(reportFileName(report())).not.toBe(reportFileName(other));
  });

  it('separates two instrument builds sharing one version string', () => {
    // The case the whole scheme exists for: every dev build carries the semver
    // of the release it branched from. If the name keyed on version alone, a
    // dev-vs-release comparison would write both sides to one file.
    const dev = reportAt({ instrument: { version: '0.1.42', commit: '2'.repeat(40), dirty: false } });
    expect(reportFileName(report())).not.toBe(reportFileName(dev));
  });

  it('separates a dirty instrument from the clean commit it was built on', () => {
    // Axis C's half of the rule directly above. A dirty build and the commit it
    // branched from are different binaries, so sharing a filename would let one
    // overwrite the other's measurement.
    const dirty = reportAt({
      instrument: { version: '0.1.42', commit: '1'.repeat(40), dirty: true },
    });
    expect(reportFileName(report())).not.toBe(reportFileName(dirty));
  });

  it('separates two runs of one dirty instrument by when they were observed', () => {
    // Unlike a dirty SUBJECT there is no fingerprint to fall back on: what ran
    // is the built output, not the checkout. So a dirty instrument is pinned by
    // observation time — weaker than an identity, and deliberately so, but it
    // does guarantee the second run never silently overwrites the first.
    const instrument = { version: '0.1.42', commit: '1'.repeat(40), dirty: true };
    const first = { ...reportAt({ instrument }), capturedAt: '2026-08-14T10:00:00.000Z' };
    const second = { ...reportAt({ instrument }), capturedAt: '2026-08-14T11:30:00.000Z' };

    expect(reportFileName(first)).not.toBe(reportFileName(second));
  });

  it('separates two dirty states of one commit', () => {
    // Fingerprints here are hex and differ in their FIRST characters on
    // purpose: the name carries only a short prefix, so two fixtures sharing
    // a prefix would compare equal no matter what the code did — a fixture
    // that cannot tell the two answers apart proves nothing.
    // Found by running the CLI, not by these tests: the first version of the
    // naming scheme keyed a git subject on its commit alone, so every dirty run
    // at one commit wrote to one filename. Two edits, two measurements, one
    // surviving file — and nothing to show a measurement had been lost.
    const dirtyA = reportAt({
      subjectVersion: {
        kind: 'git',
        commit: 'a'.repeat(40),
        ref: 'main',
        dirty: true,
        workingFingerprint: '1a2b3c4d5e6f7a8b9c0d',
      },
    });
    const dirtyB = reportAt({
      subjectVersion: {
        kind: 'git',
        commit: 'a'.repeat(40),
        ref: 'main',
        dirty: true,
        workingFingerprint: '9f8e7d6c5b4a3f2e1d0c',
      },
    });
    expect(reportFileName(dirtyA)).not.toBe(reportFileName(dirtyB));
  });

  it('separates a dirty tree from the clean commit it sits on', () => {
    const dirty = reportAt({
      subjectVersion: {
        kind: 'git',
        commit: 'a'.repeat(40),
        ref: 'main',
        dirty: true,
        workingFingerprint: '1a2b3c4d5e6f7a8b9c0d',
      },
    });
    expect(reportFileName(report())).not.toBe(reportFileName(dirty));
  });

  it('separates a snapshot subject from a git subject', () => {
    const snapshot = reportAt({
      subjectVersion: { kind: 'snapshot', fingerprint: 'deadbeefcafe', fileCount: 3 },
    });
    expect(reportFileName(report())).not.toBe(reportFileName(snapshot));
  });

  it('does not collapse subject ids that sanitise to the same string', () => {
    // Ids come from a human-edited registry, and every unsafe character
    // sanitises to a dash — so 'a/b' and 'a:b' produce the same readable slug.
    // Without a digest of the raw id they would share a filename and one
    // subject's measurement would silently overwrite the other's.
    const a = reportAt({ subject: { id: 'a/b', source: 'x' } });
    const b = reportAt({ subject: { id: 'a:b', source: 'x' } });
    expect(reportFileName(a)).not.toBe(reportFileName(b));
  });

  it('produces a name with no path separators', () => {
    const risky = reportAt({ subject: { id: '../../escape', source: 'x' } });
    expect(reportFileName(risky)).not.toContain('/');
    expect(reportFileName(risky)).not.toContain('\\');
  });
});

describe('writeReport and readReport', () => {
  it('round-trips a report through disk', async () => {
    const written = await writeReport(safePath.join(tempDir, 'run-1'), report());
    const readBack = await readReport(written);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error(readBack.refusal);
    expect(readBack.envelope.coordinate).toEqual(COORDINATE);
    expect(readBack.envelope.facet).toBe('perf');
  });

  it('creates the directory it was given', async () => {
    const nested = safePath.join(tempDir, 'deep', 'nested', 'run');
    const written = await writeReport(nested, report());
    expect(written).toContain('nested');
  });

  it('refuses to write a report it could not read back', async () => {
    // This used to compare a `formatVersion` integer, which could only catch a
    // header somebody had LABELLED wrong. Running the reader's own schema
    // catches a header that IS wrong — here, an instrument claiming cleanliness
    // over a build with no checkout to have inspected — and it needs nobody to
    // remember anything.
    const impossible = report({
      coordinate: {
        ...COORDINATE,
        instrument: { version: '0.1.42', commit: null, dirty: false },
      },
    });
    await expect(writeReport(tempDir, impossible)).rejects.toThrow(/could not read back/);
  });

  it('refuses a missing file rather than throwing', async () => {
    const result = await readReport(safePath.join(tempDir, 'does-not-exist.json'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
  });

  it('refuses a file that is not valid JSON rather than throwing', async () => {
    const bad = safePath.join(tempDir, 'broken.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture under a temp dir
    await writeFile(bad, '{ not json', 'utf-8');
    const result = await readReport(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
  });
});
