/**
 * System tests for doctor command
 *
 * Run the REAL doctor command against THIS project (VAT itself)
 * to verify self-hosting works correctly. No mocks - real execution.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { executeCli, getBinPath } from './test-common.js';

// Get the project root (VAT repo root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = safePath.join(__dirname, '../../../..'); // from packages/cli/test/system/ to project root
const PACKAGES_DIR = safePath.join(PROJECT_ROOT, 'packages');
const CLI_DIR = safePath.join(PROJECT_ROOT, 'packages/cli');

// Use the built CLI binary directly
const CLI_BIN = getBinPath(import.meta.url);

/** The counts line: `📊 Results: 7 checks — 7 passed, 0 failed, 0 undetermined, 0 skipped` */
const RESULTS_LINE =
  /Results: (\d+) checks — (\d+) passed, (\d+) failed, (\d+) undetermined, (\d+) skipped/;

interface DoctorRun {
  exitCode: number;
  output: string;
  /** Nothing failed. Says nothing about undetermined checks — read `counts` for that. */
  noFailures: boolean;
  counts: { total: number; pass: number; fail: number; undetermined: number; skipped: number };
  /** How many check blocks the renderer actually printed. */
  renderedChecks: number;
  hiddenClaim: number | null;
}

/**
 * Execute vat doctor command and return parsed result
 */
async function runVatDoctor(cwd: string, options?: { verbose?: boolean }): Promise<DoctorRun> {
  const args = options?.verbose ? ['doctor', '--verbose'] : ['doctor'];
  const result = await executeCli(CLI_BIN, args, { cwd });

  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const exitCode = result.status ?? 1;

  const match = RESULTS_LINE.exec(output);
  if (!match) {
    throw new Error(`doctor printed no results line. Output was:\n${output}`);
  }
  const n = (i: number): number => Number.parseInt(match[i] ?? '', 10);

  // One block per rendered check: an outcome icon at the start of a line.
  const renderedChecks = (output.match(/^(?:✅|❌|❓|⏭️) /gm) ?? []).length;
  // eslint-disable-next-line sonarjs/slow-regex -- single bounded digit group
  const hidden = /(\d+) not shown/.exec(output);

  return {
    exitCode,
    output,
    noFailures: exitCode === 0 && !output.includes('❌'),
    counts: {
      total: n(1),
      pass: n(2),
      fail: n(3),
      undetermined: n(4),
      skipped: n(5),
    },
    renderedChecks,
    hiddenClaim: hidden ? Number.parseInt(hidden[1] ?? '', 10) : null,
  };
}

/**
 * The invariant defect (b) violated: doctor printed "7/7 checks passed" above an
 * empty list. Whatever it hides, the numbers it prints must account for it.
 */
function expectCountsToMatchRenderedList(run: DoctorRun): void {
  const { total, pass, fail, undetermined, skipped } = run.counts;
  expect(pass + fail + undetermined + skipped).toBe(total);

  const hidden = total - run.renderedChecks;
  expect(hidden).toBeGreaterThanOrEqual(0);
  expect(run.hiddenClaim).toBe(hidden > 0 ? hidden : null);
}

describe('vat doctor - system tests (self-hosting)', () => {
  describe('running from project root', () => {
    it('nothing fails when run from project root', async () => {
      const result = await runVatDoctor(PROJECT_ROOT);

      expect(result.exitCode).toBe(0);
      expect(result.noFailures).toBe(true);
      expect(result.counts.fail).toBe(0);
      expect(result.output).toContain('vat doctor');
    });

    it('the printed counts account for every check, shown or hidden', async () => {
      const result = await runVatDoctor(PROJECT_ROOT);

      expectCountsToMatchRenderedList(result);
    });

    it('claims "All checks passed" only when every check actually passed', async () => {
      const result = await runVatDoctor(PROJECT_ROOT);

      // An undetermined check (e.g. npm unreachable in a sandboxed runner) must
      // never be reported as health — that is the whole point of the outcome.
      if (result.counts.pass === result.counts.total) {
        expect(result.output).toContain('All checks passed');
      } else {
        expect(result.output).not.toContain('All checks passed');
        expect(result.output).toContain('could not be determined');
      }
    });
  });

  describe('running from subdirectories', () => {
    it('nothing fails when run from packages/ subdirectory', async () => {
      const result = await runVatDoctor(PACKAGES_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.counts.fail).toBe(0);
      expectCountsToMatchRenderedList(result);
    });

    it('nothing fails when run from packages/cli/ subdirectory', async () => {
      const result = await runVatDoctor(CLI_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.counts.fail).toBe(0);
      expectCountsToMatchRenderedList(result);
    });

    it('shows context when running from subdirectory', async () => {
      const result = await runVatDoctor(PACKAGES_DIR);

      expect(result.output).toContain('📍 Project Context');
      expect(result.output).toContain('Current directory:');
      expect(result.output).toContain('Project root:');
    });
  });

  describe('verbose mode', () => {
    it('--verbose renders every check and hides nothing', async () => {
      const normal = await runVatDoctor(PROJECT_ROOT);
      const verbose = await runVatDoctor(PROJECT_ROOT, { verbose: true });

      expect(verbose.renderedChecks).toBe(verbose.counts.total);
      expect(verbose.hiddenClaim).toBeNull();
      expect(verbose.renderedChecks).toBeGreaterThanOrEqual(normal.renderedChecks);
      expectCountsToMatchRenderedList(verbose);
    });
  });
});
