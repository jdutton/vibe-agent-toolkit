/**
 * The fork-RSS detector (`vitest.fork-rss-budget.setup.js`) is what makes a raised integration
 * worker cap safe, so it must be able to FAIL: run a real vitest over a one-test fixture under a
 * raised-cap config and prove a budget the fork is over, and a budget never provided, each fail
 * the run with the detector's message — beside a control that passes, so a run that fails for any
 * other reason cannot pass for the detector firing.
 */
import { safePath, resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { safeExecResult } from '../../src/common.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');
const FIXTURE = safePath.join(REPO_ROOT, 'packages', 'dev-tools', 'test', 'fixtures', 'fork-rss-budget');
const VITEST = safePath.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function runProbe(budget: string): { status: number; output: string } {
  const result = safeExecResult(process.execPath, [VITEST, 'run', '--root', FIXTURE, '--config', safePath.join(FIXTURE, 'vitest.config.ts')], {
    env: { ...process.env, FORK_RSS_PROBE_BUDGET: budget },
  });
  return { status: result.status, output: `${String(result.stdout)}${String(result.stderr)}` };
}

describe('the fork-RSS detector', () => {
  it('passes a fork under its budget (the control)', () => {
    const { status, output } = runProbe('100000');
    expect(status, output).toBe(0);
  });

  it('fails a file whose fork is over the budget, naming the figure', () => {
    const { status, output } = runProbe('1');
    expect(status).not.toBe(0);
    expect(output).toMatch(/fork peak RSS \d+ MB is over the 1 MB budget/);
  });

  it('fails when no budget was provided, rather than reading it as "under"', () => {
    const { status, output } = runProbe('absent');
    expect(status).not.toBe(0);
    expect(output).toContain('over the undefined MB budget');
  });
});
