/**
 * The one way a system test bounds a published duration field by the run that contains it.
 */

import { expect } from 'vitest';

import { formatDurationSecs } from '../../../src/utils/duration.js';

/**
 * Assert that a published `*Secs` field does not exceed the report's own `durationMs`.
 *
 * 🪤 The bound is the run's duration put through the SAME rounding the field gets. A `*Secs`
 * field is `formatDurationSecs` (three significant figures) and `durationMs` is not, so
 * comparing against the raw total fails whenever the field rounds up past it: a 10.05 s
 * population inside a 10.093 s run publishes 10.1. Rounding is monotonic, so a span inside its
 * run cannot round above the run's rounded total, up to `Date.now()`'s 1 ms quantization of
 * `durationMs`.
 *
 * @param fieldSecs - The published `*Secs` field, as read off the report
 * @param durationMs - The report's `durationMs`, as read off the report
 */
export function expectSecsWithinRun(fieldSecs: unknown, durationMs: unknown): void {
  expect(typeof fieldSecs).toBe('number');
  expect(typeof durationMs).toBe('number');
  expect(fieldSecs).toBeLessThanOrEqual(formatDurationSecs(durationMs as number));
}
