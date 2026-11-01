/**
 * Shared by the tests that lint the repository programmatically. {@link repoEslint} is the one
 * way to construct the linter; the allowlist-ratchet helpers below lint a list of files with an
 * exemption lifted and count what the rule reports in each — a listed file that is clean must
 * leave the allowlist, and a list that pins its counts must match them exactly.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { ESLint, type Linter } from 'eslint';

/**
 * An ESLint for a test, with its cache file pointed outside the repository.
 *
 * With caching off, `lintFiles` DELETES the file at `cacheLocation` — by default
 * `<cwd>/.eslintcache`, which is `bun run lint`'s cache. A test constructed at the repo root
 * therefore wiped the developer's lint cache on every gate run, and the next lint ran cold
 * (100 s instead of 4 s). Constructing one anywhere else is a lint error (`ESLINT_INSTANCE_BAN`
 * in `eslint.config.js`). The cache options are not accepted: this linter never caches.
 */
export function repoEslint(options: Omit<ESLint.Options, 'cache' | 'cacheLocation' | 'cacheStrategy'>): ESLint {
  // Both set AFTER the spread: the `Omit` is compile-time only, and an options object held in a
  // variable can still carry `cache: true`.
  return new ESLint({ ...options, cache: false, cacheLocation: safePath.join(normalizedTmpdir(), 'vat-test-eslintcache') });
}

/** The two rules that carry the repo's import bans: the static half and the dynamic half. */
export const BAN_RULES = ['no-restricted-imports', 'no-restricted-syntax'] as const;

/**
 * A function that lints `code` as if it were the file `relative` of `repoRoot`, running only
 * {@link BAN_RULES}, and returns each finding as `rule: message`. The two rules read syntax alone,
 * so no program is built and the file need not exist on disk.
 */
export function banLinter(repoRoot: string): (relative: string, code: string) => Promise<string[]> {
  const eslint = repoEslint({
    cwd: repoRoot,
    ruleFilter: ({ ruleId }) => (BAN_RULES as readonly string[]).includes(ruleId),
    overrideConfig: [{ files: ['**/*.ts', '**/*.cts'], languageOptions: { parserOptions: { project: null, projectService: false } } }],
  });
  return async (relative, code) => {
    const [result] = await eslint.lintText(code, { filePath: safePath.join(repoRoot, relative) });
    return (result?.messages ?? []).map((message) => `${message.ruleId ?? 'fatal'}: ${message.message}`);
  };
}

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
