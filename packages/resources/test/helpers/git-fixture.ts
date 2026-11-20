/**
 * Git fixtures for the listing suites: one quiet git runner, and a nested repository written
 * under a parent tree, which git names as one entry and whose files the parent's oracle calls
 * ignored.
 */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';

/**
 * The fixture's git configuration, through git's `GIT_CONFIG_COUNT` channel
 * rather than `-c`: the subcommand stays `args[0]`, which is what
 * `runGitOrThrow` names in its failure.
 */
const FIXTURE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['user.email', 't@example.com'],
  ['user.name', 't'],
  ['commit.gpgsign', 'false'],
  ['protocol.file.allow', 'always'],
];

const FIXTURE_ENV: Record<string, string> = Object.fromEntries([
  ['GIT_CONFIG_COUNT', String(FIXTURE_CONFIG.length)],
  ...FIXTURE_CONFIG.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${String(index)}`, key], [`GIT_CONFIG_VALUE_${String(index)}`, value]]),
]);

/**
 * Run git in `cwd` with a committer identity, no signing, and local-file submodules allowed.
 *
 * @throws When git fails, naming the subcommand, so a fixture git never built is never mistaken for one it did
 */
export function git(cwd: string, ...args: string[]): void {
  runGitOrThrow(args, { cwd, env: FIXTURE_ENV });
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
