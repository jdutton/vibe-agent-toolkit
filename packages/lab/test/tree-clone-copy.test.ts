/**
 * A portable copy's `copy` step on a host that cannot create a link: `copyTree`
 * raises the write's raw errno for its caller to classify, and the step refuses
 * with it (the caller codes it `LAB_ARM_REFUSED`) rather than crashing.
 */

import type * as Utils from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { executeClonePlan } from '../src/harness/tree-clone.js';

const { copyTree } = vi.hoisted(() => ({ copyTree: vi.fn<typeof Utils.copyTree>() }));

vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const real = await importOriginal<typeof Utils>();
  return { ...real, copyTree };
});

describe('executeClonePlan: a copy step the host cannot write', () => {
  it('refuses, naming the step and the errno, when the host cannot create a symlink (EPERM)', async () => {
    // Node's own shape for a refused `symlink(target, link)`.
    const eperm = Object.assign(new Error("EPERM: operation not permitted, symlink 'target.md' -> '/copy/docs/link.md'"), {
      code: 'EPERM',
      errno: -4048,
      syscall: 'symlink',
      path: 'target.md',
      dest: '/copy/docs/link.md',
    });
    copyTree.mockRejectedValueOnce(eperm);

    const refusal = await executeClonePlan({ ok: true, steps: [{ kind: 'copy', from: '/subject/docs', to: '/copy/docs' }] });

    expect(refusal).toMatch(/^REFUSED: clone step 'copy \/subject\/docs \/copy\/docs' failed: EPERM: operation not permitted, symlink/u);
  });
});
