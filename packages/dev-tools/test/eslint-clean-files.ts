/**
 * Shared by the two allowlist-ratchet tests (`eslint-allowlist-ratchets.test.ts`,
 * `integration/no-unsafe-backlog-ratchet.integration.test.ts`): lint a list of
 * files with an exemption lifted and return the ones the rule stayed silent on —
 * a listed file that is clean must leave the allowlist.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import type { ESLint, Linter } from 'eslint';

/**
 * The repo-relative paths in `files` on which `isFinding` matched no message.
 *
 * A parse failure is thrown, not counted as zero — a file that did not parse
 * has no findings, and "no findings" is what the ratchet tests call clean.
 */
export async function filesWithoutFinding(
  eslint: ESLint,
  repoRoot: string,
  files: readonly string[],
  isFinding: (message: Linter.LintMessage) => boolean,
): Promise<string[]> {
  const results = await eslint.lintFiles(files.map((file) => `${repoRoot}/${file}`));
  const clean: string[] = [];
  for (const result of results) {
    const fatal = result.messages.find((m) => m.fatal);
    if (fatal) throw new Error(`${result.filePath}: ${fatal.message}`);
    if (!result.messages.some((m) => isFinding(m))) {
      clean.push(safePath.relative(repoRoot, result.filePath));
    }
  }
  return clean;
}
