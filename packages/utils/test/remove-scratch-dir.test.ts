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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `../src/`, not the package name. Importing `@vibe-agent-toolkit/utils` here
// resolves to `dist/`, which scores ZERO coverage against `src/test-helpers.ts`
// — so every line of the give-up mechanism, the whole reason this module
// exists, would read as unhit — and silently tests a stale build whenever `src`
// changes without a rebuild. Every sibling behaviour test imports from `../src/`
// for exactly this reason; only the barrel/subpath tests use the package name,
// because the resolution IS what they assert.
import { normalizedTmpdir, safePath } from '../src/path-utils.js';
import { removeScratchDir } from '../src/test-helpers.js';

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
   * The error branch is driven by injection rather than by a hostile path, and
   * that is a correction rather than a shortcut.
   *
   * The first version of this test used a path whose parent component is a
   * regular file, which yields `ENOTDIR` — `force: true` swallows `ENOENT` but
   * not that. Verified empirically... on macOS only. **Windows resolves the
   * same call silently**, so no warning fired, and the test failed in CI having
   * passed locally: a fixture that cannot produce the condition it asserts.
   *
   * What actually needs pinning is the contract — a removal that fails warns
   * instead of throwing — and that is platform-independent. Injecting the
   * failure tests it identically everywhere; fabricating one on the filesystem
   * tests the platform's error semantics as well, which is the part that
   * diverged.
   */
  it('warns and resolves when removal errors outright', async () => {
    const target = safePath.join(scratch, 'refuses-to-go');
    const { warnings, onWarn } = warningSink();

    await expect(
      removeScratchDir(target, {
        onWarn,
        remove: () => Promise.reject(new Error('EPERM: operation not permitted')),
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(target);
    expect(warnings[0]).toContain('EPERM');
  });

  it('reports a non-Error rejection without throwing on it', async () => {
    const { warnings, onWarn } = warningSink();

    await expect(
      removeScratchDir(safePath.join(scratch, 'odd-rejection'), {
        onWarn,
        // A rejection that is NOT an Error, which the String() fallback exists for.
        remove: () => Promise.reject('a bare string'),
      }),
    ).resolves.toBeUndefined();

    expect(warnings[0]).toContain('a bare string');
  });

  /**
   * The guarantee the whole design exists for. With a zero budget the timer
   * wins the race, and the call must still return normally and name the path
   * it abandoned — because the alternative, on a contended machine, is a red
   * suite in which every assertion passed.
   */
  it('gives up within its budget rather than running long, and names the leaked path', async () => {
    const root = safePath.join(scratch, 'outlives-budget');
    const { warnings, onWarn } = warningSink();

    // A removal that never settles, so the timer always wins. Racing a real
    // `fs.rm` over a handful of files against a 0ms timer is a coin flip —
    // which is how the first version of this test passed locally and would
    // have flaked anywhere slower or faster.
    await expect(
      removeScratchDir(root, { budgetMs: 5, onWarn, remove: () => new Promise<void>(() => {}) }),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(root);
    expect(warnings[0]).toContain('did not finish');
  });

  it('warns at most once, so a removal settling after the budget cannot log into a finished suite', async () => {
    const root = safePath.join(scratch, 'single-warning');
    const { warnings, onWarn } = warningSink();
    let settle: (() => void) | undefined;

    await removeScratchDir(root, {
      budgetMs: 5,
      onWarn,
      remove: () => new Promise<void>((resolve) => { settle = resolve; }),
    });
    expect(warnings).toHaveLength(1);

    // Now let the abandoned removal finish. Its `.then` must not log again —
    // the suite that called this has already ended.
    settle?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(warnings).toHaveLength(1);
  });

  /**
   * The other half of the latch, and the ordering the safety claim actually
   * rests on: a removal that **rejects** after its budget already expired. The
   * sibling above settles by resolving, which exercises the `.then` arm only —
   * so the `.catch` arm's `giveUp` was reachable in production and pinned by
   * nothing. If the latch failed to hold here the suite would see a second
   * warning; if the handler were attached after the race instead of before it,
   * this would surface as an unhandled rejection rather than a passing test.
   */
  it('stays silent when an abandoned removal rejects after the budget expired', async () => {
    const root = safePath.join(scratch, 'rejects-after-budget');
    const { warnings, onWarn } = warningSink();
    let fail: ((error: Error) => void) | undefined;

    await removeScratchDir(root, {
      budgetMs: 5,
      onWarn,
      remove: () => new Promise<void>((_resolve, reject) => { fail = reject; }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('did not finish');

    fail?.(new Error('EPERM: too late to matter'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('EPERM');
  });
});
