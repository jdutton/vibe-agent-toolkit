/**
 * `removeScratchDir` exists to make one guarantee: a teardown can never redden
 * a suite whose assertions all passed. So the load-bearing assertions here are
 * the *negative* ones — that it resolves rather than rejects — on each of the
 * three ways removal can go wrong (it errors, it outlives its budget, it was
 * never given a directory). A test that only proved "it deletes the tree"
 * would pass equally well for the bare `rm` this replaced.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is derived from a controlled mkdtemp scratch dir */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, removeScratchDir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(safePath.join(normalizedTmpdir(), 'remove-scratch-'));
});

afterAll(async () => {
  await removeScratchDir(scratch);
});

/**
 * Build a small populated tree under the suite scratch.
 *
 * @param name - Subdirectory to create
 * @returns Absolute path to the tree
 */
async function makeTree(name: string): Promise<string> {
  const root = safePath.join(scratch, name);
  await mkdir(safePath.join(root, 'nested/deeper'), { recursive: true });
  await writeFile(safePath.join(root, 'a.txt'), 'a');
  await writeFile(safePath.join(root, 'nested/b.txt'), 'b');
  await writeFile(safePath.join(root, 'nested/deeper/c.txt'), 'c');
  return root;
}

/** Collects warnings so the give-up notice is assertable without stubbing console. */
function warningSink(): { warnings: string[]; onWarn: (message: string) => void } {
  const warnings: string[] = [];
  return { warnings, onWarn: (message: string) => warnings.push(message) };
}

describe('removeScratchDir', () => {
  it('removes a populated tree and warns about nothing', async () => {
    const root = await makeTree('populated');
    const { warnings, onWarn } = warningSink();

    await removeScratchDir(root, { onWarn });

    expect(existsSync(root)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('treats an already-absent directory as done, not as a failure', async () => {
    const { warnings, onWarn } = warningSink();

    await expect(
      removeScratchDir(safePath.join(scratch, 'never-existed'), { onWarn }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('is a no-op for an empty path, so a suite whose beforeAll never ran can still call it', async () => {
    const { warnings, onWarn } = warningSink();

    await expect(removeScratchDir('', { onWarn })).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  /**
   * A path whose parent component is a regular file yields `ENOTDIR`, which
   * `force: true` does NOT swallow the way it swallows `ENOENT` — verified
   * empirically before this test was written. That makes it the one portable
   * way to drive the error branch without depending on chmod semantics or on
   * the test not running as root.
   */
  it('warns and resolves when removal errors outright', async () => {
    const file = safePath.join(scratch, 'a-file');
    await writeFile(file, 'not a directory');
    const target = safePath.join(file, 'child');
    const { warnings, onWarn } = warningSink();

    await expect(removeScratchDir(target, { onWarn })).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(target);
  });

  /**
   * The guarantee the whole design exists for. With a zero budget the timer
   * wins the race, and the call must still return normally and name the path
   * it abandoned — because the alternative, on a contended machine, is a red
   * suite in which every assertion passed.
   */
  it('gives up within its budget rather than running long, and names the leaked path', async () => {
    const root = await makeTree('outlives-budget');
    const { warnings, onWarn } = warningSink();

    await expect(removeScratchDir(root, { budgetMs: 0, onWarn })).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(root);
    expect(warnings[0]).toContain('did not finish');
  });

  it('warns at most once, so a removal settling after the budget cannot log into a finished suite', async () => {
    const root = await makeTree('single-warning');
    const { warnings, onWarn } = warningSink();

    await removeScratchDir(root, { budgetMs: 0, onWarn });
    // Let the abandoned removal run to completion in the background.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(warnings).toHaveLength(1);
  });
});
