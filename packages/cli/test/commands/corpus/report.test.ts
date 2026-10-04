import { mkdtempSync, readFileSync, statSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { writeRunOutput, writeRunReport, type RunReport, type PluginRow } from '../../../src/commands/corpus/report.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';

const FROZEN_TIMESTAMP = '2026-05-01T18:34:56Z';
const SUMMARY_FILE = 'summary.yaml';

/** Read the summary index written into `runDir`. */
function readSummary(runDir: string): Record<string, unknown> {
  return yaml.parse(readFileSync(safePath.join(runDir, SUMMARY_FILE), 'utf-8')) as Record<string, unknown>;
}

function makeTempOutDir(): string {
  return mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-report-'));
}

function makeReport(rows: PluginRow[]): RunReport {
  return {
    generated_at: FROZEN_TIMESTAMP,
    vat_version: '0.1.34-rc.4',
    vat_commit: 'bfba3329',
    seed_file: 'corpus/seed.yaml',
    flags: { with_review: false, debug: false },
    plugins: rows,
  };
}

function cleanRow(name: string, source = '.', filesScanned = 1): PluginRow {
  return {
    source,
    name,
    validation_applied: false,
    audit: {
      status: 'ok',
      duration_ms: 10,
      summary: { errors: 0, warnings: 0, info: 0 },
      files_scanned: filesScanned,
      findings_emitted: 0,
      output_path: `${name}-audit.yaml`,
    },
    review: { status: 'skipped', duration_ms: 0 },
  };
}

describe('writeRunReport', () => {
  it('writes summary.yaml with totals derived from plugin rows', async () => {
    const outDir = makeTempOutDir();
    const report = makeReport([
      cleanRow('a'),
      {
        source: 'b/c',
        name: 'b',
        validation_applied: true,
        audit: { status: 'findings', duration_ms: 20, summary: { errors: 0, warnings: 1, info: 0 },
      files_scanned: 2, findings_emitted: 1, output_path: 'b-audit.yaml' },
        review: { status: 'skipped', duration_ms: 0 },
      },
      {
        source: 'd',
        name: 'd',
        validation_applied: false,
        audit: { status: 'findings', duration_ms: 20, summary: { errors: 2, warnings: 0, info: 0 },
      files_scanned: 1, findings_emitted: 2, output_path: 'd-audit.yaml' },
        review: { status: 'skipped', duration_ms: 0 },
      },
      {
        source: 'broken/url',
        name: 'broken',
        validation_applied: false,
        audit: { status: 'unloadable', duration_ms: 5, error: 'Clone failed: ...' },
        review: { status: 'skipped', duration_ms: 0 },
      },
    ]);

    const runDir = await writeRunReport(report, outDir);

    const summaryPath = safePath.join(runDir, SUMMARY_FILE);
    expect(statSync(summaryPath).isFile()).toBe(true);

    const written = readSummary(runDir);

    // No `schema_version` — the package version is the only version this
    // project has, and a reader's own strict schema is what decides readability.
    expect(written).not.toHaveProperty('schema_version');
    expect(written.totals).toEqual({
      plugins: 4,
      audit_ok: 1,
      audit_findings: 2,
      audit_with_errors: 1,
      unloadable: 1,
    });
  });

  it('includes reviewed total when --with-review was set', async () => {
    const outDir = makeTempOutDir();
    const reviewedRow = cleanRow('a');
    reviewedRow.review = { status: 'ok', duration_ms: 100, output_path: 'a-review.md' };
    const report = makeReport([reviewedRow]);
    report.flags.with_review = true;

    const runDir = await writeRunReport(report, outDir);
    const totals = readSummary(runDir).totals as Record<string, number>;
    expect(totals.reviewed).toBe(1);
    expect(totals.review_error).toBe(0);
  });

  it('counts rows whose review lane failed in review_error', async () => {
    const outDir = makeTempOutDir();
    const okRow = cleanRow('a');
    okRow.review = {
      status: 'ok',
      duration_ms: 100,
      summary: { skills_scanned: 2, reviewed: 2, failed: 0 },
      output_path: 'a-review.md',
    };
    const partialRow = cleanRow('b');
    partialRow.review = {
      status: 'error',
      duration_ms: 100,
      summary: { skills_scanned: 10, reviewed: 1, failed: 9 },
      error: '9 of 10 skill reviews failed.',
      output_path: 'b-review.md',
    };
    const report = makeReport([okRow, partialRow]);
    report.flags.with_review = true;

    const runDir = await writeRunReport(report, outDir);
    const totals = readSummary(runDir).totals as Record<string, number>;
    expect(totals.reviewed).toBe(2);
    expect(totals.review_error).toBe(1);
  });

  it('creates a date-sha-named subdirectory under outDir', async () => {
    const outDir = makeTempOutDir();
    const report = makeReport([cleanRow('x', '.', 0)]);

    const runDir = await writeRunReport(report, outDir);

    // Run dir name format: <YYYY-MM-DD>-<short-sha>
    // safePath.join always returns forward slashes (cross-platform), so split is safe here.
    // eslint-disable-next-line local/no-hardcoded-path-split -- safePath normalizes to forward slashes
    const segments = runDir.split('/');
    const last = segments.at(-1) ?? '';
    expect(last).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  });
});

/** What `write` threw once `writeRunOutput` had classified it. */
function thrownBy(write: () => void): unknown {
  try {
    writeRunOutput('out/summary.yaml', write);
  } catch (error) {
    return error;
  }
  throw new Error('writeRunOutput did not throw');
}

/** An OS error as Node shapes it: the `code` is the contract. */
const errno = (code: string): Error => Object.assign(new Error(`${code}: refused`), { code });

describe('writeRunOutput', () => {

  // A full disk and a failing device under --out are the run not finishing, never VAT's defect.
  it.each(['ENOSPC', 'EIO', 'EACCES', 'EROFS', 'EDQUOT'])('refuses %s as RUN_INCOMPLETE, naming what it was writing', (code) => {
    const error = thrownBy(() => {
      throw errno(code);
    });

    expect(refusalCodeOf(error)).toBe('RUN_INCOMPLETE');
    expect((error as Error).message).toContain('Could not write out/summary.yaml');
  });

  it('lets a non-errno throw through untouched — a defect is not the environment\'s', () => {
    const defect = new TypeError('undefined is not a function');

    expect(thrownBy(() => {
      throw defect;
    })).toBe(defect);
  });
});
