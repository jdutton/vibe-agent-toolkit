/**
 * The pure halves of the store-size and touched-LFS arms: the touch clock, the
 * snapshot reading, the filter log, the filter command and the commit count.
 */

import { isVatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { filterCommand, parseFilterLog, refuseUnlessStoreHit, snapshotReading, touchSeconds } from '../src/facets/perf/lfs-touch.js';
import { commitsToReplay } from '../src/facets/perf/store-size.js';
import { ARM_REFUSED_CODE } from '../src/harness/arm-dirs.js';

/**
 * @param run - What should refuse
 * @returns The refusal's message, after asserting it is coded {@link ARM_REFUSED_CODE}
 */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (isVatError(error, ARM_REFUSED_CODE)) return error.message;
    throw error;
  }
  throw new Error('expected a LAB_ARM_REFUSED refusal; nothing was thrown');
}

describe('touchSeconds', () => {
  it('moves every touch strictly below the backdated second, a second no file or index entry has held', () => {
    // Far from the clock, so the answer cannot depend on when the test runs.
    const backdated = 1_000_000;
    const seconds = touchSeconds(backdated, 3);

    expect(seconds).toEqual([999_999, 999_998, 999_997]);
  });
});

describe('snapshotReading', () => {
  it('reports a build that emits no git.snapshots as unread, with the reason, never as 0', () => {
    const reading = snapshotReading({ ok: true, merged: { processes: 1, counters: [] } });

    expect(reading).toEqual({ gitSnapshots: null, workRefusal: 'the measured vat does not emit git.snapshots' });
  });

  it('reports the counter when the build emits it', () => {
    const reading = snapshotReading({ ok: true, merged: { processes: 1, counters: [{ name: 'git.snapshots', count: 2 }] } });

    expect(reading).toEqual({ gitSnapshots: 2, workRefusal: null });
  });
});

describe('refuseUnlessStoreHit', () => {
  it('passes a touched step served from the store', () => {
    expect(() => refuseUnlessStoreHit({ population: 'store' }, 0)).not.toThrow();
  });

  it('refuses, with a code, a touched step that derived its population or published none', () => {
    expect(refusal(() => refuseUnlessStoreHit({ population: 'derived' }, 1))).toBe(
      "lfs-touch round 1: the touched step reported population 'derived', not 'store' — it measured no store hit",
    );
    expect(refusal(() => refuseUnlessStoreHit({ population: null }, 0))).toMatch(/population 'unpublished', not 'store'/u);
  });
});

describe('parseFilterLog', () => {
  it('counts one invocation per line and sums the bytes', () => {
    expect(parseFilterLog('65536\n65536\n12\n', '/log')).toEqual({ invocations: 3, bytes: 131_084 });
    expect(parseFilterLog('', '/log')).toEqual({ invocations: 0, bytes: 0 });
  });

  it('refuses a line that is not a byte count, naming the log and the line', () => {
    expect(refusal(() => parseFilterLog('65536\noops\n', '/arms/filter.log'))).toBe(
      "the LFS filter log '/arms/filter.log' holds a line that is not a byte count: 'oops'",
    );
  });
});

describe('filterCommand', () => {
  it('double-quotes the runtime and the script', () => {
    expect(filterCommand('/opt/node 24/bin/node', '/lab/test/fixtures/lfs-filter.mjs', 'clean')).toBe(
      '"/opt/node 24/bin/node" "/lab/test/fixtures/lfs-filter.mjs" clean',
    );
  });

  it.for(['/tmp/a"b/node', '/tmp/$HOME/node', '/tmp/a`id`/node'])('refuses %s, which sh would not read verbatim', (path) => {
    expect(refusal(() => filterCommand(path, '/lab/filter.mjs', 'smudge'))).toContain('holds a character sh reads inside double quotes');
  });
});

describe('commitsToReplay', () => {
  it('returns the listed commits, oldest first as rev-list --reverse gave them', () => {
    expect(commitsToReplay('aaa\nbbb\nccc\n', 3, '/subject')).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('refuses --commits above the first-parent commits HEAD has, naming both numbers', () => {
    expect(refusal(() => commitsToReplay('aaa\nbbb\n', 5, '/subject'))).toBe(
      "'/subject' has 2 first-parent commits at HEAD; --commits asks for 5",
    );
  });
});
