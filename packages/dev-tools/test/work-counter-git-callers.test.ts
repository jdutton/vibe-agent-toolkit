/**
 * Every git process a shipped package starts is counted as `git.calls`.
 *
 * The shipped runtime packages reach git through exactly two calls, both from
 * `@vibe-validate/git`: `executeGitCommand` and `getGitTreeSnapshot`. Every
 * other route (`runGit`, `getToolVersion('git')`) funnels into the first, so it
 * is counted once, there; a count at the outer call would count it twice. The
 * modules that make those calls are listed below and each must count. A new caller fails until it counts and is listed; a
 * listed module that stopped calling fails until it is delisted, so the list
 * cannot rot into one that passes for modules that no longer spawn anything.
 *
 * Out of scope: private packages (the lab, dev-tools, the test agents) and test
 * helpers, which never run in an adopter's process.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

/** The modules that start git, each counting it. */
const GIT_CALLERS = ['packages/utils/src/git-run.ts', 'packages/utils/src/git-snapshot.ts'];

/** A call that starts git: the two `@vibe-validate/git` entry points. */
const GIT_CALL = /\b(?:executeGitCommand|getGitTreeSnapshot)\(/u;

/** The count each caller must make. */
const GIT_COUNT = "countWork('git.calls', 1)";

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/**
 * @param file - A repo-relative source path under `packages/<dir>/src/`
 * @returns Whether its package is published
 */
function isShipped(file: string): boolean {
  const dir = /^packages\/([^/]+)\//u.exec(file)?.[1] ?? '';
  const manifest = JSON.parse(readFileSync(safePath.join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf-8')) as {
    private?: boolean;
  };
  return manifest.private !== true;
}

/** @returns Whether the file is a test helper that ships beside runtime code */
function isTestHelper(file: string): boolean {
  return file.includes('/src/testing/') || file.endsWith('/src/testing.ts') || file.includes('test-helpers');
}

describe('git calls in shipped packages', () => {
  const sources = packageSources();
  const callers = [...sources]
    .filter(([file, source]) => isShipped(file) && !isTestHelper(file) && GIT_CALL.test(source))
    .map(([file]) => file)
    .sort((a, b) => a.localeCompare(b));

  it('are made only by the listed modules, and every listed module still makes one', () => {
    expect(callers).toEqual(GIT_CALLERS);
  });

  it.each(GIT_CALLERS)('%s counts each one', (file) => {
    expect(sources.get(file)).toContain(GIT_COUNT);
  });
});
