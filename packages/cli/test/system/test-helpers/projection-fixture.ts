/**
 * The two-document git tree that every `vat resources check` system case runs
 * against.
 *
 * ## Why it is shared rather than repeated
 *
 * Two files now drive this verb — the assertion semantics and the time bound —
 * and each needs the same starting point: a real git repository (the ignore
 * oracle is `gitTrackerForProjectRoot`, so without one a `.gitignore` is just a
 * file) holding at least one markdown document (so `membersEnumerated` is above
 * zero and a passing run is not vacuous). Spelled out twice it is a duplication
 * failure under this repo's zero-tolerance policy, and — the part that actually
 * bites — two fixtures that can drift, so one file's "clean run" could stop
 * meaning what the other's does.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import { createTestTempDir } from './project-setup.js';

/**
 * Create a temp git repository holding two markdown documents.
 *
 * 🪤 The tree must stay NON-EMPTY. A case that wants an emptied corpus builds
 * its own — the whole point of `membersEnumerated` is that "passed" and "had
 * nothing to pass over" are different documents, and a shared fixture that
 * could be either would dissolve the distinction for every case above it.
 *
 * @param prefix - Temp-directory prefix, so a failing run is attributable
 * @returns The absolute path to the new tree
 */
export function createMarkdownGitFixture(prefix: string): string {
  const dir = createTestTempDir(prefix);
  mkdirSyncReal(safePath.join(dir, 'docs'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
  writeFileSync(safePath.join(dir, 'docs/a.md'), '# Alpha\n', 'utf-8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
  writeFileSync(safePath.join(dir, 'docs/b.md'), '# Bravo\n', 'utf-8');
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture setup
  spawnSync('git', ['init', '--quiet'], { cwd: dir });
  return dir;
}
