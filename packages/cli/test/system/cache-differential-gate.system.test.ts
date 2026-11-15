/**
 * I0, unseeded: with the store off, cold and warm from the same history, every
 * verb answers the gate fixture identically and refuses nothing.
 *
 * The fixture has what each verb reads: markdown with links, anchors and
 * frontmatter, an HTML file, a `CLAUDE.md` with an `@import`, a `.claude/rules`
 * file, declared checks, and an untracked file so `changed_files` has a row.
 * The store-off dump must hold rows in every relation not declared empty, so
 * an arm cannot agree by every arm having nothing. The harness and its tells:
 * `../helpers/cache-differential.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  expectCoverage,
  expectNoDivergenceAndNoRefusal,
  gateSubject,
  removeCells,
  runDifferential,
  type DifferentialResult,
} from '../helpers/cache-differential.js';

import { createSuiteContext, join } from './test-common.js';

const context = createSuiteContext('vat-i0-gate-', import.meta.url);

let result: DifferentialResult;

describe('the projection store changes what a run costs, never what it answers', () => {
  beforeAll(async () => {
    context.setup();
    result = await runDifferential({ binPath: context.binPath, subject: gateSubject(join(context.createTempDir(), 'corpus')) });
  });

  afterAll(() => {
    removeCells();
    context.cleanup();
  });

  it('answers every verb in every arm exactly as store-off does, with a zero refusal census', () => {
    expect(result.arms).toEqual(['storeOff', 'cold', 'warmSameHistory']);
    expect(result.verbs).toEqual(['validate', 'check', 'query', 'context']);
    expectNoDivergenceAndNoRefusal(result);
  });

  it('dumps rows in every relation the fixture is not declared to leave empty', () => {
    const dump = result.measured.storeOff.query;
    if (dump === undefined) throw new Error('no store-off dump');
    expectCoverage(dump.document);
  });
});
