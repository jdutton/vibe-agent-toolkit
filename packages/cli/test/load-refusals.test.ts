/**
 * `expectAnswersAsStoreOff` drops only the load refusals a run counted: everything else still
 * fails the comparison.
 */

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { expectAnswersAsStoreOff, loadRefusalClause, type RunAnswer } from './helpers/load-refusals.js';

const LINK = { code: 'LINK_BROKEN', severity: 'error', message: "'a.md' links to a missing file", location: 'a.md' };
const OUTPUT_ROWS = {
  code: 'RESOURCE_PARSE_LIMIT_EXCEEDED',
  severity: 'error',
  message: "'r.md' was enumerated but its parse was stopped at its outputRows limit (10 rows), so it is not in the index.",
  location: 'r.md',
};

/** A load refusal of `location` at `limit`. */
function loadRefusal(location: string, limit: 'timeMs' | 'heapMb'): typeof OUTPUT_ROWS {
  return { ...OUTPUT_ROWS, message: `'${location}' was enumerated but ${loadRefusalClause(limit, '30000 ms wall clock')}, so it is not in the index.`, location };
}

function run(findings: readonly object[], loadRefusals = 0, status = 1): RunAnswer {
  return { status, stdout: stringify({ status: 'findings', findings }), loadRefusals };
}

describe('expectAnswersAsStoreOff', () => {
  it('passes on equal answers', () => {
    expectAnswersAsStoreOff(run([LINK, OUTPUT_ROWS]), run([LINK, OUTPUT_ROWS]));
  });

  it('drops the store-off run\'s load refusals at either limit when it counted them', () => {
    expectAnswersAsStoreOff(
      run([LINK, OUTPUT_ROWS]),
      run([LINK, loadRefusal('big.md', 'timeMs'), OUTPUT_ROWS, loadRefusal('huge.md', 'heapMb')], 2),
    );
  });

  it('counts a load refusal once per file, however many lanes report it', () => {
    const big = loadRefusal('big.md', 'timeMs');
    expectAnswersAsStoreOff(run([LINK]), run([big, LINK, { ...big, message: `${big.message} (skills lane)` }], 1));
  });

  it('fails when the store-off run dropped more load refusals than it counted', () => {
    expect(() => expectAnswersAsStoreOff(run([LINK]), run([LINK, loadRefusal('big.md', 'timeMs')], 0))).toThrow(/every load refusal dropped/);
  });

  it('allows a counted load refusal its report does not carry (a checks child refused under load)', () => {
    expectAnswersAsStoreOff(run([LINK], 1), run([LINK], 1));
  });

  it('drops the warm run\'s load refusal when it counted it', () => {
    expectAnswersAsStoreOff(run([LINK, loadRefusal('big.md', 'timeMs')], 1), run([LINK]));
  });

  it('fails when the warm run dropped a load refusal it did not count', () => {
    expect(() => expectAnswersAsStoreOff(run([LINK, loadRefusal('big.md', 'timeMs')], 0), run([LINK]))).toThrow(/warm: every load refusal dropped/);
  });

  it('fails on an extra finding that is not a load refusal, beside a dropped one', () => {
    expect(() => expectAnswersAsStoreOff(run([LINK]), run([LINK, OUTPUT_ROWS, loadRefusal('big.md', 'timeMs')], 1))).toThrow(/warm answers as store-off does/);
  });

  it('fails on a different exit code', () => {
    expect(() => expectAnswersAsStoreOff(run([LINK], 0, 0), run([LINK], 0, 1))).toThrow(/warm answers as store-off does/);
  });
});
