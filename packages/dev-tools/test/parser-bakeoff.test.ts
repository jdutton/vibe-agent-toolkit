import { describe, expect, it } from 'vitest';

import {
  type ArmReport,
  checkCorpus,
  numericFlag,
  summarise,
} from '../src/parser-bakeoff.js';

// ---------------------------------------------------------------------------
// Fixtures — external constants, never derived from the code under test.
// ---------------------------------------------------------------------------

/** The calibrated corpus the bake-off's numbers were taken against. */
const FILES = 1266;

/** That corpus's byte count. */
const BYTES = 23_866_376;

/** The arm running VAT's own processor. */
const REMARK = 'remark-parse';

/** The arm running the rival. */
const RIVAL = 'markdown-it';

/** The flag that pins the corpus's file count. */
const EXPECT_FILES = '--expect-files';

/** The flag that pins the corpus's byte count. */
const EXPECT_BYTES = '--expect-bytes';

/**
 * One arm's report, with whatever a test wants to vary.
 *
 * @param overrides - Fields to replace
 * @returns A complete report
 */
function reportOf(overrides: Partial<ArmReport> = {}): ArmReport {
  return {
    arm: REMARK,
    documents: FILES,
    bytes: BYTES,
    samples: [100, 200],
    ...overrides,
  };
}

describe('the parser bake-off', () => {
  describe('reading a numeric flag', () => {
    it('returns null when the flag is absent, so an expectation is opt-in', () => {
      expect(numericFlag(['--rounds', '3'], EXPECT_FILES)).toBeNull();
    });

    it('reads the value that follows the flag', () => {
      expect(numericFlag(['--rounds', '3'], '--rounds')).toBe(3);
    });

    it('REFUSES a flag with no number after it, rather than defaulting', () => {
      // A silently-defaulted expectation is an expectation that checks nothing,
      // which is the whole failure this guard exists to prevent.
      expect(() => numericFlag([EXPECT_FILES], EXPECT_FILES)).toThrow(/needs a number/);
      expect(() => numericFlag([EXPECT_FILES, 'lots'], EXPECT_FILES)).toThrow(/needs a number/);
    });
  });

  describe('refusing an uncalibrated corpus', () => {
    it('accepts a run with no expectations stated', () => {
      expect(() => checkCorpus(reportOf(), [])).not.toThrow();
    });

    it('accepts the corpus the expectations describe', () => {
      const argv = [EXPECT_FILES, String(FILES), EXPECT_BYTES, String(BYTES)];
      expect(() => checkCorpus(reportOf(), argv)).not.toThrow();
    });

    it('REFUSES a corpus with a different file count', () => {
      const argv = [EXPECT_FILES, String(FILES)];
      expect(() => checkCorpus(reportOf({ documents: FILES - 1 }), argv)).toThrow(/expected 1266 markdown files/);
    });

    it('REFUSES a corpus whose bytes moved even though its file count did not', () => {
      // The count alone cannot see an edited corpus, and a ratio taken against
      // edited content is not comparable with the one already on record.
      const argv = [EXPECT_FILES, String(FILES), EXPECT_BYTES, String(BYTES)];
      expect(() => checkCorpus(reportOf({ bytes: BYTES + 1 }), argv)).toThrow(/expected 23866376 bytes/);
    });
  });

  describe('summarising an arm', () => {
    it('takes the MINIMUM across every process that ran the arm', () => {
      // Not the median: one interrupted pass survives a median into the number
      // being compared, and this benchmark has measured 3x outliers in the wild.
      const reports = [
        reportOf({ samples: [900, 800] }),
        reportOf({ samples: [700, 3000] }),
        reportOf({ arm: RIVAL, samples: [10] }),
      ];
      expect(summarise(reports, REMARK).minMs).toBe(700);
    });

    it('keeps every sample, so the spread stays visible behind the minimum', () => {
      const reports = [reportOf({ samples: [900, 800] }), reportOf({ samples: [700] })];
      expect(summarise(reports, REMARK).samples).toEqual([900, 800, 700]);
    });

    it('reads only the named arm, so one arm cannot borrow the other minimum', () => {
      const reports = [reportOf({ samples: [900] }), reportOf({ arm: RIVAL, samples: [10] })];
      expect(summarise(reports, REMARK).minMs).toBe(900);
      expect(summarise(reports, RIVAL).minMs).toBe(10);
    });

    it('THROWS when an arm produced nothing, rather than reporting a zero', () => {
      // `Math.min()` of an empty list is Infinity and a defaulted 0 would be the
      // fastest arm ever measured. Neither may reach a table.
      expect(() => summarise([reportOf({ arm: RIVAL })], REMARK)).toThrow(/no samples/);
    });
  });
});
