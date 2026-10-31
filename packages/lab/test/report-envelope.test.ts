/**
 * A report's `removedEnv` is what its measured children ran WITHOUT, taken from
 * the children's own runs — never recomputed from the environment the report
 * happens to be stamped in, which can differ from the one the children saw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { exactExit } from '../src/harness/commands.js';
import { RecordedExitSchema } from '../src/harness/exit-record.js';
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
 * @param exits - Each repetition's exit, one step each: `null` for a step that started and was killed
 * @returns A measured command as the header reads it
 */
function measured(name: string, removed: readonly string[], exits: readonly (number | null)[] = [], npmNetwork: readonly string[] = []) {
  const results = exits.map((exitCode) => ({ steps: [{ name, exitCode }] })) as never;
  return { removed, npmNetwork, spec: { name, exit: exactExit(0) }, results };
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

describe('buildReportEnvelope — npmNetworkEnv', () => {
  it("is the sorted union of the npm network setting names every measured command's children kept", () => {
    const envelope = buildReportEnvelope('perf', REQUEST, {}, [
      measured('a', [], [], ['npm_config_registry']),
      measured('b', [], [], ['npm_config_proxy', 'npm_config_registry']),
    ]);

    expect(envelope.npmNetworkEnv).toStrictEqual(['npm_config_proxy', 'npm_config_registry']);
  });
});

describe('buildReportEnvelope — exits', () => {
  it("records each command's commitment and the code its repetitions shared, and tells a disagreement from a step that never ran", () => {
    const envelope = buildReportEnvelope('perf', REQUEST, {}, [measured('same', [], [1, 1]), measured('mixed', [], [0, 1]), measured('never', [], [])]);

    expect(envelope.exits).toStrictEqual([
      { step: 'same', commitment: exactExit(0), outcome: 'shared', code: 1 },
      { step: 'mixed', commitment: exactExit(0), outcome: 'disagreed', code: null, seen: [0, 1] },
      { step: 'never', commitment: exactExit(0), outcome: 'not-run', code: null },
    ]);
  });

  it('reads a step killed in every repetition as killed, never as not run, and names a kill in a disagreement', () => {
    const lateStarter = { removed: [], npmNetwork: [], spec: { name: 'late', exit: exactExit(0) }, results: [{ steps: [] }, { steps: [{ name: 'late', exitCode: 0 }] }] as never };

    const envelope = buildReportEnvelope('perf', REQUEST, {}, [measured('hung', [], [null, null]), measured('half', [], [0, null]), lateStarter]);

    expect(envelope.exits).toStrictEqual([
      { step: 'hung', commitment: exactExit(0), outcome: 'killed', code: null },
      { step: 'half', commitment: exactExit(0), outcome: 'disagreed', code: null, seen: [0, 'killed'] },
      { step: 'late', commitment: exactExit(0), outcome: 'disagreed', code: null, seen: ['not-run', 0] },
    ]);
  });

  it('refuses a record whose code contradicts its outcome', () => {
    expect(RecordedExitSchema.safeParse({ step: 's', commitment: exactExit(0), outcome: 'shared', code: null }).success).toBe(false);
    expect(RecordedExitSchema.safeParse({ step: 's', commitment: exactExit(0), outcome: 'not-run', code: 0 }).success).toBe(false);
    expect(RecordedExitSchema.safeParse({ step: 's', commitment: exactExit(0), observed: 0 }).success).toBe(false);
  });
});
