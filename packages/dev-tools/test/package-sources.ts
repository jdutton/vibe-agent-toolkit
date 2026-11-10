/**
 * Every package source file, read from the tree, for the structure tests that
 * hold a convention over all of `packages/＊/src`.
 */

import { readFileSync } from 'node:fs';

import { isPathAbsentError, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';

/** The repository root. */
const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/**
 * Every package source file, repo-relative, with its text. Untracked files
 * count (a new file is held before it is committed); a tracked file deleted but
 * not yet committed is skipped — the crawl answers from git's index.
 *
 * @returns Repo-relative forward-slash path → file text
 */
export function packageSources(): Map<string, string> {
  const files = crawlDirectorySync({
    outputs: [],
    baseDir: REPO_ROOT,
    include: ['packages/*/src/**/*.ts'],
    includeUntracked: true,
    absolute: false,
    unreadable: { refuse: { root: REPO_ROOT, remedy: 'Fix the directory permissions and re-run.', side: 'source' } },
  });
  const out = new Map<string, string>();
  for (const file of files) {
    try {
      out.set(toForwardSlash(file), readFileSync(safePath.join(REPO_ROOT, file), 'utf-8'));
    } catch (error) {
      if (!isPathAbsentError(error)) throw error;
    }
  }
  return out;
}
