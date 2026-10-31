/**
 * A report's `removedEnv` is what its measured children ran WITHOUT, taken from
 * the children's own runs — never recomputed from the environment the report
 * happens to be stamped in, which can differ from the one the children saw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { exactExit } from '../src/harness/commands.js';
import { buildReportEnvelope } from '../src/harness/report.js';
import type { CaptureRequest } from '../src/harness/types.js';

import { COORDINATE } from './report-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The fields of a capture request the envelope reads. */
const REQUEST = {
  subject: { ref: COORDINATE.subject, version: COORDINATE.subjectVersion },
  instrument: { version: COORDINATE.instrument },
  env: { set: {}, unset: [] },
  capturedAt: '2026-10-31T00:00:00.000Z',
} as unknown as CaptureRequest;

/**
 * @param name - The command
 * @param removed - What its children went without
 * @param exits - Each repetition's exit, one step each
 * @returns A measured command as the header reads it
 */
function measured(name: string, removed: readonly string[], exits: readonly number[] = []) {
  const results = exits.map((exitCode) => ({ steps: [{ name, exitCode }] })) as never;
  return { removed, spec: { name, exit: exactExit(0) }, results };
}

describe('buildReportEnvelope — removedEnv', () => {
  it("is the sorted union of every measured command's children's removed names", () => {
    const envelope = buildReportEnvelope('perf', REQUEST, {}, [measured('a', ['XDG_CONFIG_HOME', 'TMPDIR']), measured('b', ['TMPDIR', 'GIT_EXEC_PATH'])]);

    expect(envelope.removedEnv).toStrictEqual(['GIT_EXEC_PATH', 'TMPDIR', 'XDG_CONFIG_HOME']);
  });

  it('names nothing the children did not go without, whatever the stamping environment carries', () => {
    vi.stubEnv('VAT_LAB_STAMPED_AFTER_THE_RUN', 'x');

    expect(buildReportEnvelope('perf', REQUEST, {}, []).removedEnv).toStrictEqual([]);
  });
});

describe('buildReportEnvelope — exits', () => {
  it("records each command's commitment and the code its repetitions shared, or null when they differed", () => {
    const envelope = buildReportEnvelope('perf', REQUEST, {}, [measured('same', [], [1, 1]), measured('mixed', [], [0, 1])]);

    expect(envelope.exits).toStrictEqual([
      { step: 'same', commitment: exactExit(0), observed: 1 },
      { step: 'mixed', commitment: exactExit(0), observed: null },
    ]);
  });
});
