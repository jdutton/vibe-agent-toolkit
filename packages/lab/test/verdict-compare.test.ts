/**
 * `compareVerdict` over hand-built envelopes — pure, no spawn. The end-to-end
 * failability proof is the planted-delta integration suite; this file pins the
 * rules that need more than one alias to reach.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareVerdict } from '../src/facets/verdict/compare.js';
import type { VerdictBody } from '../src/facets/verdict/types.js';

import { PROBE_VERSION } from './command-probe.js';

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
          verdict: { exitCode: 0, shape: 'legacy', findings: [] },
          document: 'status: success\n',
        },
      ],
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
