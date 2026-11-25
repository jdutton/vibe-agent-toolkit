/**
 * The typecheck task script itself refuses a run the root `typecheck` script did not build for.
 *
 * `programTaskRefusal()` is unit-tested on its own; this runs the script that calls it, so a call
 * that asks the wrong question (as `'lint'`, which never refuses without `VAT_LINT_TASK`) is red.
 *
 * Integration tier: it spawns `node`.
 */

import { spawnSync } from 'node:child_process';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../../src/common.js';
import { TYPECHECK_TASK_FILE } from '../../src/generate-lint-config.js';

describe(TYPECHECK_TASK_FILE, () => {
  it('exits non-zero with the refusal, before running tsc, when VAT_BUILT is unset', () => {
    const env = { ...process.env };
    delete env['VAT_BUILT'];
    delete env['VAT_LINT_TASK'];
    const result = spawnSync(NODE_EXECUTABLE, [safePath.join(PROJECT_ROOT, TYPECHECK_TASK_FILE), 'tsconfig.root.json'], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/A typecheck task reads workspace types from dist\/ and is cached on them, so it runs only after a build: run `bun run typecheck`/);
  });
});
