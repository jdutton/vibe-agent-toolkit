/**
 * Every test worker observes its work counts from its first line (the shared vitest setup), so no
 * test has to read the counters before the work it measures for that work to be counted.
 */

import { workCountsObserved } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

describe('a test worker', () => {
  it('observes its work counts before any test reads them', () => {
    expect(workCountsObserved()).toBe(true);
  });
});
