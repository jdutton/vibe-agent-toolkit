/**
 * A test reset of the work counters takes back the exit write an installed dump
 * registered, so the next test can install one again without leaving a second
 * write behind to file the same counts at exit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { tempDirTracker } from '../../src/testing/temp-dir.js';
import { __resetWorkCountersForTest } from '../../src/testing.js';
import { installWorkCounterDump, WORK_COUNTERS_ENV } from '../../src/work-counters.js';

const scratch = tempDirTracker('work-counter-dump-reset-');

describe('resetting the work counters under test', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetWorkCountersForTest();
    scratch.cleanupAll();
  });

  it('removes the exit write an installed dump registered', () => {
    vi.stubEnv(WORK_COUNTERS_ENV, scratch.create());
    const listeners = process.listenerCount('exit');

    installWorkCounterDump('cli');
    expect(process.listenerCount('exit')).toBe(listeners + 1);

    __resetWorkCountersForTest();
    expect(process.listenerCount('exit')).toBe(listeners);
  });
});
