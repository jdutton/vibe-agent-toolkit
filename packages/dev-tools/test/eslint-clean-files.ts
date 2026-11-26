/**
 * Shared by the tests that lint the repository programmatically: the allowlist-ratchet helpers
 * below lint a list of files with an exemption lifted and count what the rule reports in each — a
 * listed file that is clean must leave the allowlist, and a list that pins its counts must match
 * them exactly.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';
import { ESLint, type Linter } from 'eslint';
import picomatch from 'picomatch';

/**
 * The repository's root `eslint.config.js`, loaded as a module. It is plain JavaScript with no
 * declaration file, so each caller names, as `T`, exactly the exports it reads.
 */
export async function importRootEslintConfig<T extends object>(): Promise<T> {
  const configFile = resolveFromImportMeta(import.meta.url, '..', '..', '..', 'eslint.config.js');
  return (await import(pathToFileURL(configFile).href)) as T;
}

/** The two rules that carry the repo's import bans: the static half and the dynamic half. */
export const BAN_RULES = ['no-restricted-imports', 'no-restricted-syntax'] as const;

/**
 * A function that lints `code` as if it were the file `relative` of `repoRoot`, running only
 * {@link BAN_RULES}, and returns each finding as `rule: message`. The two rules read syntax alone,
 * so no program is built and the file need not exist on disk.
 */
export function banLinter(repoRoot: string): (relative: string, code: string) => Promise<string[]> {
  return syntaxRuleLinter(repoRoot, BAN_RULES);
}

/**
 * {@link banLinter} for any set of rules that read syntax alone: lints `code` as the file
 * `relative` of `repoRoot`, running only `rules`, each finding as `rule: message`.
 */
export function syntaxRuleLinter(
  repoRoot: string,
  rules: readonly string[],
): (relative: string, code: string) => Promise<string[]> {
  const eslint = new ESLint({
    cwd: repoRoot,
    ruleFilter: ({ ruleId }) => rules.includes(ruleId),
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

/** The extensions the boundary rules are enabled for in `eslint.config.js`. */
const SCRIPT_EXTENSIONS = '{ts,cts,mts,js,cjs,mjs}';

/**
 * Every script under a package's `src` or `test` that `rule` reports when it is enabled on every
 * file, the config's exemptions included, repo-relative. The rule is the one predicate: a test
 * holding an exemption list to the tree cannot disagree with the rule on what a finding is.
 *
 * @param repoRoot - The repository root
 * @param rule - The rule, as the config names it (`local/...`)
 * @param mayReport - A narrowing only, never the verdict: whether a file could hold a finding at all
 * @returns The files the rule reports
 */
export async function filesTheRuleReports(
  repoRoot: string,
  rule: string,
  mayReport: (file: string, text: string) => boolean,
): Promise<string[]> {
  const eslint = new ESLint({
    cwd: repoRoot,
    ruleFilter: ({ ruleId }) => ruleId === rule,
    overrideConfig: [
      { files: ['**/*.ts', '**/*.cts'], languageOptions: { parserOptions: { project: null, projectService: false } } },
      // After the repo's own blocks, so it reaches the files the config exempts.
      { files: [`**/*.${SCRIPT_EXTENSIONS}`], rules: { [rule]: 'error' } },
    ],
  });
  const files = crawlDirectorySync({
    outputs: [],
    baseDir: repoRoot,
    include: [`packages/*/src/**/*.${SCRIPT_EXTENSIONS}`, `packages/*/test/**/*.${SCRIPT_EXTENSIONS}`],
    includeUntracked: true,
    absolute: false,
    unreadable: { refuse: { root: repoRoot, remedy: 'Fix the directory permissions and re-run.', side: 'source' } },
  });
  const candidates = files
    .map((each) => toForwardSlash(each))
    .map((file) => ({ file, text: readFileSync(safePath.join(repoRoot, file), 'utf-8') }))
    .filter(({ file, text }) => mayReport(file, text));
  const verdicts = await Promise.all(candidates.map(async ({ file, text }) => {
    const [result] = await eslint.lintText(text, { filePath: safePath.join(repoRoot, file) });
    const messages = result?.messages ?? [];
    const fatal = messages.find((message) => message.fatal === true);
    if (fatal !== undefined) throw new Error(`${file}: ${fatal.message}`);
    return messages.some((message) => message.ruleId === rule) ? file : undefined;
  }));
  return verdicts.filter((file): file is string => file !== undefined);
}

/**
 * An exemption list held both ways against the files a rule reports: the files no glob exempts,
 * and the globs that exempt no reported file (a stale hole). Both are empty for a list that is
 * exactly right.
 *
 * @param reported - The files the rule reports with no exemption ({@link filesTheRuleReports})
 * @param exempt - The config's exemption globs
 * @returns The unexempted files and the unused globs
 */
export function exemptionDrift(
  reported: readonly string[],
  exempt: readonly string[],
): { readonly unexempted: readonly string[]; readonly unused: readonly string[] } {
  const matchers = exempt.map((glob) => [glob, picomatch(glob)] as const);
  return {
    unexempted: reported.filter((file) => !matchers.some(([, matches]) => matches(file))),
    unused: matchers.filter(([, matches]) => !reported.some((file) => matches(file))).map(([glob]) => glob),
  };
}
