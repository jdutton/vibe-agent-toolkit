/**
 * Every verb's lane, in the one table: where its run reads a tracked file's bytes.
 *
 * A validation lane that read disk would be served nothing warm and key what git holds from disk;
 * a build lane that read git would ship and rewrite bytes that are not the working tree's. The
 * table is the one place the choice is made, so this pins it entry by entry, and pins that the code
 * opening a run names its verb from it: every verb the source opens a run as is in the table, every
 * table entry is a verb the source opens a run as, and no lane is a literal anywhere else.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { RUN_MEMBER_BYTES } from '../../src/utils/run-lanes.js';

const SRC = safePath.resolve(import.meta.dirname, '../../src');

/**
 * Each way the source opens a run (or its members) handing it a verb: a literal, or the file's own
 * `VERB` constant. A caller that forwards a verb it was handed (`verb,`, `options.verb`) names
 * none: its callers do.
 */
const VERB_AT_RUN_OPENERS: readonly RegExp[] = [
  /withRunContext\(\{ verb: ('[^']+'|VERB)/gu,
  /storeMembersOf\([^,()]+, ('[^']+'|VERB)/gu,
  /runInOwnRun\(\s*('[^']+'|VERB)/gu,
  /withQueriedProjection\([^;]{0,600}?verb: ('[^']+'|VERB)/gu,
];

/** A file's `VERB` constant. */
const VERB_CONSTANT = /^const VERB = '([^']+)';$/mu;

/** Every `.ts` file under `directory`, with its text. */
function sourcesUnder(directory: string): Array<{ readonly path: string; readonly text: string }> {
  return readdirSync(directory, { recursive: true, encoding: 'utf-8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => {
      const path = safePath.join(directory, name);
      return { path, text: readFileSync(path, 'utf-8') };
    });
}

/** The verbs `text` names where it opens a run. */
function verbsOpenedIn(text: string): string[] {
  const constant = VERB_CONSTANT.exec(text)?.[1];
  return VERB_AT_RUN_OPENERS.flatMap((opener) => [...text.matchAll(opener)].map((match) => {
    const named = match[1] ?? '';
    return named === 'VERB' ? constant ?? 'VERB without a `const VERB`' : named.slice(1, -1);
  }));
}

describe('RUN_MEMBER_BYTES', () => {
  it('reads git members for every cached validation lane, and disk for every build lane and rag index', () => {
    const verbsReading = (lane: string): string[] => Object.entries(RUN_MEMBER_BYTES)
      .filter(([, bytes]) => bytes === lane)
      .map(([verb]) => verb)
      .sort((a, b) => a.localeCompare(b));
    expect(verbsReading('git'), 'the cached validation lanes').toEqual([
      'claude context', 'inventory', 'resources check', 'resources query', 'resources scan',
      'resources validate', 'skill review', 'skills validate', 'validate', 'verify',
    ]);
    expect(verbsReading('disk'), 'the build lanes, rag index, and audit (which holds no store)').toEqual([
      'audit', 'claude plugin build', 'rag index', 'skill test run', 'skills build', 'skills package',
    ]);
  });

  it('names exactly the verbs the source opens a run as', () => {
    const opened = new Set(sourcesUnder(SRC).flatMap(({ text }) => verbsOpenedIn(text)));
    expect([...opened].sort((a, b) => a.localeCompare(b))).toEqual(Object.keys(RUN_MEMBER_BYTES).sort((a, b) => a.localeCompare(b)));
  });

  it('is the only place a lane is chosen', () => {
    const choosing = sourcesUnder(SRC)
      .filter(({ path, text }) => !path.endsWith('/run-lanes.ts') && /memberBytes\s*[:=]/u.test(text))
      .map(({ path }) => safePath.relative(SRC, path));
    expect(choosing).toEqual([]);
  });
});
