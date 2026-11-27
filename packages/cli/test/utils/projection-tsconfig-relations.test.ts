/**
 * The tsconfig step's answer as the run database takes it: its eight relations' rows, or one
 * refusal under every `tsconfig_*` name, the step's code leading the message.
 */

import type { TsconfigAnswer } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { tsconfigRelations } from '../../src/utils/projection-query.js';

const TSCONFIG_NAMES = ['tsconfig_closure', 'tsconfig_conditions', 'tsconfig_configs', 'tsconfig_extends', 'tsconfig_files', 'tsconfig_invocations', 'tsconfig_paths', 'tsconfig_references'];

describe('tsconfigRelations', () => {
  it('writes the eight relations\' rows and refuses nothing when the step answered', () => {
    const empty = { invocations: [], references: [], closure: [], configs: [], extends: [], files: [], paths: [], conditions: [] };
    const { rows, refusals } = tsconfigRelations({ outcome: 'rows', typescript: '6.0.3', rows: empty });
    expect(refusals.size).toBe(0);
    expect(Object.keys(rows)).toHaveLength(TSCONFIG_NAMES.length);
  });

  it('refuses every tsconfig_* relation with one refusal, the step\'s code first, retryable as RUN_INCOMPLETE', () => {
    const answer = (retryable: boolean): TsconfigAnswer => ({
      outcome: 'refused',
      typescript: null,
      refusal: { code: 'TSCONFIG_PARSE_ERRORS', root: 'r0', path: 'tsconfig.json', message: 'it has errors.', remedy: 'fix it', retryable },
    });
    const { rows, refusals } = tsconfigRelations(answer(false));
    expect(rows).toStrictEqual({});
    expect([...refusals.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(TSCONFIG_NAMES);
    expect(refusals.get('tsconfig_files')).toStrictEqual({ refusal: 'INPUT_UNREADABLE', refused: 'TSCONFIG_PARSE_ERRORS: it has errors. Fix: fix it.' });
    expect(tsconfigRelations(answer(true)).refusals.get('tsconfig_paths')?.refusal).toBe('RUN_INCOMPLETE');
  });

  it('is nothing when the family was not demanded', () => {
    expect(tsconfigRelations(undefined)).toStrictEqual({ rows: {}, refusals: new Map() });
  });
});
