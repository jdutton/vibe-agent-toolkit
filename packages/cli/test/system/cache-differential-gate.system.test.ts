/**
 * I0, unseeded: with the store off, cold and warm from the same history, every
 * verb answers the gate fixture identically and refuses nothing. The `stores`
 * slice of the gate; the others run in `cache-differential-gate-*.system.test.ts`.
 *
 * The fixture has what each verb reads: markdown with links, anchors and
 * frontmatter, an HTML file, a `CLAUDE.md` with an `@import`, a `.claude/rules`
 * file, declared checks, and an untracked file so `changed_files` has a row.
 * The store-off dump must hold rows in every relation not declared empty, so
 * an arm cannot agree by every arm having nothing. The harness and its tells:
 * `../helpers/cache-differential.ts`.
 */

import { describe, it } from 'vitest';

import { expectCoverage, GATE_SLICES, gateSuite } from '../helpers/cache-differential.js';

describe('the projection store changes what a run costs, never what it answers', () => {
  const gate = gateSuite(GATE_SLICES.stores, import.meta.url);

  it('answers every verb in every arm exactly as store-off does, with a zero refusal census', gate.expectAgreement);

  it('dumps rows in every relation the fixture is not declared to leave empty', () => {
    const dump = gate.result().measured.storeOff.query;
    if (dump === undefined) throw new Error('no store-off dump');
    expectCoverage(dump.document);
  });
});
