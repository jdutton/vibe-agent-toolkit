/**
 * I0, the refusal seed: a file over a parse limit is refused the same way in
 * every arm, and the census counts it in the limit bucket, once per verb.
 *
 * The file is committed and `@import`ed from `CLAUDE.md`, so `claude context`
 * reaches it as surely as the resource verbs do. Its bytes are generated once,
 * so both arms read the same file (the generator stamps a fresh nonce per call).
 */

import { overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GATE_FIXTURE, seedSuite, seedTitle, type I0Seed } from '../helpers/cache-differential.js';

import { writeFileTree } from './test-common.js';

const HUGE_PATH = 'docs/huge.md';
const HUGE_TEXT = overOutputRowsMarkdown('one.md');

const limitBreach: I0Seed = {
  name: 'limitBreach',
  arms: ['storeOff', 'cold'],
  stateA: (corpus, git) => {
    writeFileTree(corpus, { [HUGE_PATH]: HUGE_TEXT, 'CLAUDE.md': `${GATE_FIXTURE['CLAUDE.md'] ?? ''}\n@${HUGE_PATH}\n` });
    git(['add', '--', HUGE_PATH, 'CLAUDE.md']);
    git(['commit', '-q', '-m', 'a file over a parse limit']);
    return Promise.resolve();
  },
  expect: { refuses: { perVerb: { validate: 1, check: 1, query: 1, context: 1 }, bucket: 'limit' } },
  consumed: {
    runs: ['storeOff:measured', 'cold:measured'],
    check: (runs) => {
      for (const label of ['storeOff:measured', 'cold:measured'] as const) {
        for (const run of Object.values(runs[label] ?? {})) expect(run.stdout, `${label} ${run.verb}`).toContain(HUGE_PATH);
      }
    },
  },
};

const suite = seedSuite(import.meta.url);

describe('a file over a parse limit is refused alike in every arm', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  it(seedTitle(limitBreach), async () => {
    expect(await suite.run(limitBreach)).toEqual(limitBreach.arms);
  });
});
