/**
 * Check 16 of `pre-publish-check --release-readiness`, end to end: the flag on
 * the command line reaches the known-defects gate, and a blocking entry stops a
 * stable version with FINDINGS, naming the entry. The gate's own decision is
 * unit-tested in `known-defects-gate.test.ts`; this file pins only the wiring a
 * unit test cannot see — a hard-wired `releaseReadiness: false`, or a deleted
 * Check 16, passes every unit test and is red here.
 *
 * Integration tier: it spawns the script against a fixture tree (a bare local
 * `origin` and a loopback registry, so nothing touches a network).
 */

import { spawnSync } from 'node:child_process';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { STABLE_TAG_BLOCKER_MARKER } from '../../src/known-defects-gate.js';
import { SCOPE_LISTING_PATH } from '../../src/npm-registry-guard.js';

import { fakeRegistry, fixtureTree, PRE_PUBLISH, prePublish, releaseFixtures } from './pre-publish-fixture.js';

const BLOCKING_ENTRY = 'A fixture defect that blocks the stable tag';

function register(blocking: boolean): string {
  return `# Known defects\n\n### ${BLOCKING_ENTRY}\n\n${blocking ? STABLE_TAG_BLOCKER_MARKER : '- **Severity:** Minor'}\n`;
}

/** Run the check over a tree at `version` whose register blocks the stable tag or not; the registry holds nothing. */
async function run(version: string, blocking: boolean): Promise<{ status: number | null; stdout: string }> {
  const root = fixtureTree(version, { 'docs/contributing/known-defects.md': register(blocking) });
  return prePublish(root, await fakeRegistry({ [SCOPE_LISTING_PATH]: {} }));
}

describe('pre-publish-check --release-readiness: Check 16 (known defects)', () => {
  afterEach(releaseFixtures);

  it('refuses a stable version with FINDINGS, naming the blocking entry', async () => {
    const { status, stdout } = await run('1.0.0', true);
    expect(stdout).toContain('Checking known defects that block the stable tag');
    expect(stdout).toContain(`- ${BLOCKING_ENTRY}`);
    expect(status).toBe(ExitCode.FINDINGS);
  });

  it('passes a prerelease over the same blocking entry', async () => {
    const { status, stdout } = await run('1.0.0-rc.1', true);
    expect(stdout).toContain('No known defect blocks this version');
    expect(status).toBe(ExitCode.OK);
  });

  it('passes a stable version whose register blocks nothing', async () => {
    const { status, stdout } = await run('1.0.0', false);
    expect(stdout).toContain('No known defect blocks this version');
    expect(status).toBe(ExitCode.OK);
  });

  it('refuses to run without --root rather than checking whatever tree it stands in', () => {
    const result = spawnSync(NODE_EXECUTABLE, ['--import', 'tsx', PRE_PUBLISH.script, '--skip-git-checks'], {
      cwd: PRE_PUBLISH.packageDir,
      encoding: 'utf8',
    });
    expect(result.stderr).toContain('--root DIR is required');
    expect(result.status).toBe(ExitCode.ERROR);
  });
});
