/**
 * A process-wide `--max-semi-space-size` sizes every isolate's young generation over a worker's
 * `resourceLimits`; the pool reads the real ceiling, so a heap breach is stopped at its bound
 * before V8 stops the worker, three times in a row, in a child process that must exit 0
 * (`parse-pool-child.ts`).
 */

import { describe, expect, it } from 'vitest';

import { heapBreachUnder, onCommandLine } from './parse-pool-child.js';

describe('a process-wide semi-space flag', () => {
  // `--max-semi-space-size` sizes every isolate's young generation at three of it, over a worker's
  // `resourceLimits`, which still report the size they were given (Node 26.7: 192 or 96, by host). Read from
  // `resourceLimits`, V8's ceiling under 512 and 128 read 704 for a real 512, and the stop sat at 528,
  // past it; under 128 and 16 the read was not positive and the pool fell back to its own 2,048.
  // Either way V8 reached its ceiling first, which under fast allocation kills the whole process.
  it.each([
    ['--max-old-space-size=512 --max-semi-space-size=128', '384 MiB heap'],
    ['--max-old-space-size=128 --max-semi-space-size=16', '64 MiB heap'],
    // V8 rounds the semi-space up to a power of two: 40 is a 192 MiB young generation, 100 a 384.
    // Read as 3 × the flag, the stop under 600 and 100 sat at 268 MiB, and V8 stopped the worker
    // near 203 MiB used.
    ['--max-heap-size=600 --max-semi-space-size=40', '204 MiB heap'],
    ['--max-heap-size=600 --max-semi-space-size=100', '184 MiB heap'],
  ])('under %s, stops a breach at the bound read from the real ceiling, three times in a row, and the process survives', (flags, bound) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder(onCommandLine(flags), 1024, 0);

      expect(outcome.limit).toBe('heapMb');
      expect(outcome.bound).toBe(`${bound}, lowered from 1024 MiB by a process-wide V8 heap flag (--max-old-space-size, --max-heap-size or --max-semi-space-size)`);
    }
  });
});
