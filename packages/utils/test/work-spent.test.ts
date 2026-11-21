/**
 * The one definition of a parse lookup, which every work-counter suite sums the same way.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { __resetWorkCountersForTest, PARSE_LOOKUP_COUNTERS, workSpentNow } from '../src/testing.js';
import { countWork, WORK_COUNTER_NAMES, type WorkCounter } from '../src/work-counters.js';

describe('workSpentNow().parseLookups', () => {
  beforeEach(() => {
    __resetWorkCountersForTest();
  });

  it('counts one lookup per document the parse lane answered, never a second dispatch of one', () => {
    // Written out, not derived: the test states the definition rather than restating its code.
    const answered: readonly WorkCounter[] = [
      'parse.cache.hit',
      'parse.dispatched',
      'parse.refused.keyDetermined',
      'parse.refused.inputCap.read',
      'parse.refused.inputCap.dispatch',
      'parse.refused.load',
    ];
    for (const name of answered) countWork(name, 1);
    countWork('parse.redispatched', 1);

    expect(workSpentNow().parseLookups).toBe(answered.length);
  });

  it('names every parse counter either a lookup or the redispatch, so a new one is a decision', () => {
    const parseCounters = WORK_COUNTER_NAMES.filter((name) => name.startsWith('parse.'));
    expect(new Set(parseCounters)).toEqual(new Set([...PARSE_LOOKUP_COUNTERS, 'parse.redispatched']));
  });
});
