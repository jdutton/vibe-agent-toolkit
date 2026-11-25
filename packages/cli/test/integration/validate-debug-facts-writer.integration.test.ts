/**
 * The debug-facts writer on disk: a seam that is off writes nothing, and one that is on writes the
 * one dump the facts state, under a pid-claimed name.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openDebugFacts,
  validateDebugFacts,
  VALIDATE_DEBUG_FACTS_ENV,
  writeDebugFacts,
  type ChecksPhaseObservation,
} from '../../src/commands/validate-debug-facts.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

const SEQUENTIAL: ChecksPhaseObservation = { mode: 'sequential', declinedBy: { condition: 'not-hit' } };

let work: string;
beforeEach(() => {
  work = createTestTempDir('vat-debug-facts-');
});
afterEach(() => {
  cleanupTestTempDir(work);
});

describe('writeDebugFacts', () => {
  it('writes nothing when the env is unset', () => {
    const directory = openDebugFacts({});

    expect(writeDebugFacts(directory, SEQUENTIAL)).toBeNull();
    // An unset directory resolving to the working directory would land the dump there.
    expect(readdirSync(process.cwd()).filter((name) => name.startsWith('validate-debug-facts-'))).toEqual([]);
  });

  it('writes the facts the run observed, once, into the directory the env names', () => {
    const named = safePath.join(work, 'facts');
    const directory = openDebugFacts({ [VALIDATE_DEBUG_FACTS_ENV]: named });

    const written = writeDebugFacts(directory, SEQUENTIAL);

    expect(readdirSync(named)).toEqual([`validate-debug-facts-${String(process.pid)}.json`]);
    expect(written).toBe(safePath.join(named, `validate-debug-facts-${String(process.pid)}.json`));
    expect(JSON.parse(readFileSync(safePath.join(named, readdirSync(named)[0] ?? ''), 'utf8'))).toEqual(validateDebugFacts(SEQUENTIAL));
  });
});
