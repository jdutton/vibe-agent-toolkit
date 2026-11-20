/**
 * Git fixtures for the listing suites: one quiet git runner, and a nested repository written
 * under a parent tree, which git names as one entry and whose files the parent's oracle calls
 * ignored.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';

/** Run git in `cwd`, quietly, with a committer identity and local-file submodules allowed. */
export function git(cwd: string, ...args: string[]): void {
  spawnSync(gitExecutable(), ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'ignore' });
}

/**
 * A repository at `relative` under `parent` holding one `README.md`, initialized and, when
 * `commit` says so, committed.
 *
 * @returns The nested repository's absolute path
 */
export function nestedRepository(parent: string, relative: string, commit: boolean): string {
  const sub = safePath.join(parent, relative);
  mkdirSyncReal(sub, { recursive: true });
  writeFileSync(safePath.join(sub, 'README.md'), '# Sub\n');
  git(sub, 'init', '-q');
  if (commit) {
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 'sub');
  }
  return sub;
}
