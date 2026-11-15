/**
 * The org commands' default date windows: N days back (datetime and date-only)
 * and the first of the current month.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultDaysAgo, defaultDaysAgoDateOnly, defaultFirstOfMonth } from '../../../src/commands/claude/org/helpers.js';

describe('org default date windows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts back from now, and anchors the month window on its first day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));

    expect(new Date(defaultDaysAgo(7)).getDate()).toBe(8);
    expect(defaultDaysAgoDateOnly(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(new Date(defaultFirstOfMonth()).getDate()).toBe(1);
  });
});
