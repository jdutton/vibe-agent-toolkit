/**
 * `vat skills build` — what a refused run that could not clean up after itself tells the operator.
 *
 * A run that leaves before its output lands (a packager defect, a refusal inside the build
 * bracket) discards what it staged beside `dist/skills`. When the OS refuses that discard, the
 * refusal stays the run's own — its code, its message — and the staged tree left behind is named
 * in the published document as a `TREE_CLEANUP_INCOMPLETE` warning, never lost behind it.
 *
 * The packager is stubbed because a defect cannot be staged from a fixture; the refused removal
 * is injected with `installFaultFs` under the test's own temp project.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath, VatError } from '@vibe-agent-toolkit/utils';
import { installFaultFs, type FaultRule } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSkillsBuildPhase } from '../../../src/commands/skills/build.js';
import { publishedPhase } from '../../helpers/published-phase.js';
import { createTempDirTracker } from '../../system/test-common.js';

const DEFECT = new TypeError("Cannot read properties of undefined (reading 'size')");

const harness = vi.hoisted(() => ({ rejectWith: undefined as Error | undefined }));

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) =>
  (await import('../../helpers/stubbed-packager.js')).withPackagerFailing(importOriginal, harness, () => DEFECT));

const PREVIOUS = 'previous\n';

/** Whether `path` is the tree staged beside `dist/skills` (never a parked `.previous`). */
const isStaged = (path: string): boolean => path.includes('.vat-staged-') && !path.endsWith('.previous');

/** The staged tree's removal refused: its first try, and its retry after the walk (each rule fires once). */
const stagedRemoval = (): FaultRule => ({ family: 'remove', op: 'rm', path: isStaged, errno: 'EACCES' });

interface PublishedRefusal {
  status: string;
  error: { code: string; message: string };
  findings: Array<{ code: string; severity: string; link?: string }>;
}

/**
 * Build one skill over a previous `dist/skills` while the discard of the staged tree is refused,
 * and return the published refusal — after checking its exit code, its refusal code and that the
 * previous output is untouched.
 */
async function refusalWithDiscardRefused(cwd: string, code: string): Promise<PublishedRefusal> {
  await mkdir(safePath.join(cwd, 'dist', 'skills', 'kept'), { recursive: true });
  await writeFile(safePath.join(cwd, 'dist', 'skills', 'kept', 'SKILL.md'), PREVIOUS);
  await mkdir(safePath.join(cwd, 'skills', 'demo'), { recursive: true });
  await writeFile(
    safePath.join(cwd, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A skill whose packaging is made to throw in a test.\n---\n\n# demo\n\nNothing to see.\n',
  );
  await writeFile(safePath.join(cwd, 'vibe-agent-toolkit.config.yaml'), 'skills:\n  include: ["skills/**/SKILL.md"]\n');

  const session = installFaultFs({ within: cwd, faults: [stagedRemoval(), stagedRemoval()] });
  let published: ReturnType<typeof publishedPhase<PublishedRefusal>>;
  try {
    published = publishedPhase<PublishedRefusal>('skills build', await runSkillsBuildPhase(cwd, {}, []));
  } finally {
    session.restore();
  }

  expect(published.exitCode).toBe(ExitCode.ERROR);
  expect(published.document).toMatchObject({ status: 'error', error: { code } });
  await expect(readFile(safePath.join(cwd, 'dist', 'skills', 'kept', 'SKILL.md'), 'utf8')).resolves.toBe(PREVIOUS);
  return published.document;
}

/** The one warning naming the staged tree the run could not discard. */
function stagedLeftover(document: PublishedRefusal): string | undefined {
  const leftovers = document.findings.filter((finding) => finding.code === 'TREE_CLEANUP_INCOMPLETE');
  expect(leftovers).toHaveLength(1);
  expect(leftovers[0]?.severity).toBe('warning');
  return leftovers[0]?.link;
}

describe('vat skills build - a staged tree the refused run could not discard is named in the document', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-recovery-');

  afterEach(() => cleanupTempDirs());

  it('a packager defect: the refusal is the defect\'s, and the staged tree left is a warning naming it', async () => {
    const document = await refusalWithDiscardRefused(createTempDir(), 'INTERNAL_ERROR');

    expect(document.error.message).toContain(DEFECT.message);
    expect(stagedLeftover(document)).toMatch(/\/dist\/\.skills\.vat-staged-[^/]+$/);
  });

  // The build bracket itself throwing (a git snapshot refusing an unreadable file) leaves the same way.
  it('a refusal inside the build bracket: the refusal keeps its own code, and the staged tree left is a warning naming it', async () => {
    const refusal = new VatError('GIT_SNAPSHOT_UNREADABLE', 'private.txt is unreadable');
    harness.rejectWith = refusal;
    try {
      const document = await refusalWithDiscardRefused(createTempDir(), 'INPUT_UNREADABLE');

      expect(document.error.message).toContain(refusal.message);
      expect(stagedLeftover(document)).toMatch(/\/dist\/\.skills\.vat-staged-[^/]+$/);
    } finally {
      harness.rejectWith = undefined;
    }
  });
});
