/**
 * Shared by the two allowlist-ratchet tests (`eslint-allowlist-ratchets.test.ts`,
 * `integration/no-unsafe-backlog-ratchet.integration.test.ts`): lint a list of
 * files with an exemption lifted and count what the rule reports in each — a
 * listed file that is clean must leave the allowlist, and a list that pins its
 * counts must match them exactly.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import type { ESLint, Linter } from 'eslint';

/**
 * How many messages `isFinding` matched in each of `files`, keyed by the
 * repo-relative path (a clean file is present, at 0).
 *
 * A parse failure is thrown, not counted as zero — a file that did not parse
 * has no findings, and "no findings" is what the ratchet tests call clean.
 */
export async function findingCounts(
  eslint: ESLint,
  repoRoot: string,
  files: readonly string[],
  isFinding: (message: Linter.LintMessage) => boolean,
): Promise<Record<string, number>> {
  const results = await eslint.lintFiles(files.map((file) => `${repoRoot}/${file}`));
  const counts: Record<string, number> = {};
  for (const result of results) {
    const fatal = result.messages.find((m) => m.fatal);
    if (fatal) throw new Error(`${result.filePath}: ${fatal.message}`);
    counts[safePath.relative(repoRoot, result.filePath)] = result.messages.filter((m) => isFinding(m)).length;
  }
  return counts;
}

/** The repo-relative paths in `files` on which `isFinding` matched no message ({@link findingCounts} of 0). */
export async function filesWithoutFinding(
  eslint: ESLint,
  repoRoot: string,
  files: readonly string[],
  isFinding: (message: Linter.LintMessage) => boolean,
): Promise<string[]> {
  const counts = await findingCounts(eslint, repoRoot, files, isFinding);
  return Object.keys(counts).filter((file) => counts[file] === 0);
}
