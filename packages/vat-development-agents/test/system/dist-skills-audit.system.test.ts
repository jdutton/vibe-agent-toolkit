/**
 * `vat audit` over this package's own BUILT skills (`dist/skills`).
 *
 * It lives here, not in the cli package, because the input is this package's build: `test:system`
 * depends on `build`, so turbo orders the build first and folds its hash into this task's — the
 * audit re-runs when the skills change, and fails on an absent build instead of passing without
 * auditing anything.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const distSkillsDir = safePath.join(packageRoot, 'dist/skills');
// The cli is a workspace dependency, so `^build` has built its binary.
const cliBin = safePath.join(packageRoot, '../cli/dist/bin.js');

/** Run `vat audit --verbose <dir>`, returning its exit code instead of throwing on a non-zero one. */
async function audit(dir: string): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(NODE_EXECUTABLE, [cliBin, 'audit', '--verbose', dir], {
      cwd: packageRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failed.code !== 'number') throw error;
    return { status: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

describe('vat audit of the built skills (system test)', () => {
  it('audits every built skill without an error', async () => {
    expect(fs.existsSync(distSkillsDir), `${distSkillsDir} is missing — build this package first`).toBe(true);

    const result = await audit(distSkillsDir);

    // Exit 1 is an error-severity finding in a skill this package ships, which is a failure here.
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = (yaml.parseAllDocuments(result.stdout)[0]?.toJSON() ?? {}) as Record<string, unknown>;
    expect(parsed['examined']).toBeGreaterThan(1);
  });
});
