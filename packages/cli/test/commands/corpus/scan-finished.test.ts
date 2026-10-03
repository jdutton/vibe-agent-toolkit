/**
 * What `vat corpus scan` publishes for the entries it finished: one data row
 * per entry, and a CORPUS_ENTRY_INCOMPLETE warning for each one it could not.
 */

import { describe, expect, it } from 'vitest';

import type { PluginRow } from '../../../src/commands/corpus/report.js';
import { __internal } from '../../../src/commands/corpus/scan.js';

/** A row; `over` replaces the audit or review outcome under test. */
function row(name: string, over: Partial<Pick<PluginRow, 'audit' | 'review'>> = {}): PluginRow {
  return {
    source: `./plugins/${name}`,
    name,
    validation_applied: false,
    audit: { status: 'ok', duration_ms: 1, output_path: `${name}-audit.yaml` },
    review: { status: 'skipped', duration_ms: 0 },
    ...over,
  };
}

describe('finishedScan', () => {
  it('publishes every finished row, and warns once per entry that did not finish, by seed index', () => {
    const work = __internal.finishedScan(
      [
        row('clean'),
        row('broken', { audit: { status: 'unloadable', duration_ms: 1, error: 'EACCES' } }),
        row('half', { review: { status: 'error', duration_ms: 1 } }),
      ],
      { outDir: '/out', runDirName: 'run-1' },
    );

    expect(work.examined).toBe(3);
    expect(work.data.entries).toEqual([
      { name: 'clean', audit: 'ok', review: 'skipped', outputPath: 'run-1/clean-audit.yaml' },
      { name: 'broken', audit: 'unloadable', review: 'skipped', outputPath: null },
      { name: 'half', audit: 'ok', review: 'error', outputPath: 'run-1/half-audit.yaml' },
    ]);
    expect(work.findings).toEqual([
      expect.objectContaining({ code: 'CORPUS_ENTRY_INCOMPLETE', field: 'plugins[1]', message: 'broken: audit could not run: EACCES' }),
      expect.objectContaining({ field: 'plugins[2]', message: 'half: review did not finish: no reason recorded' }),
    ]);
  });
});
