/**
 * Tree-copy stream for plugin build.
 *
 * Copies everything under <sourceDir> to <destDir>, except:
 *   - .claude-plugin/ (owned by plugin.json merge-write)
 *   - agent-instruction files at any depth, in ANY case (CLAUDE.md, Claude.md,
 *     agents.md, …) — a case-insensitive filesystem resolves every spelling to
 *     the same lookup Claude Code performs
 *   - anything the caller names in `exclude` (glob, or a bare/trailing-slash
 *     directory name; a pattern matching nothing is returned to the caller)
 *
 * Respects .gitignore via crawlDirectory (respectGitignore: true, the default).
 * Returns counts keyed to the spec's YAML summary extension.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AGENT_INSTRUCTION_FILE_PATTERNS, toAnyDepthGlobs } from '@vibe-agent-toolkit/agent-skills';
import { crawlDirectory, isGlob, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

export interface TreeCopyOptions {
  sourceDir: string;
  destDir: string;
  /**
   * Names of `skills/<dir>` entries that ANOTHER build phase produces, and which
   * this verbatim copy must therefore leave alone.
   *
   * A skill is produced by the packager (pool-packaged, or packaged in place from
   * the plugin's own source), never by a verbatim copy — copying a skill dir
   * wholesale is what used to ship eval suites, scratch files, and un-rewritten
   * links to plugin consumers. Callers must pass exactly the dirs they produced:
   * a `skills/` subdirectory that is NOT a skill (a shared helper dir, a template
   * dir, the parent of a nested skill) has no other producer, so excluding it here
   * would drop it from the bundle entirely.
   */
  excludeSkillDirs?: string[];
  /**
   * Project-specific patterns (relative to `sourceDir`) to leave out of the
   * bundle — the `exclude:` knob on the marketplace plugin entry.
   *
   * The escape hatch for junk the defaults below cannot know about (scratch dirs,
   * design notes, internal fixtures). Additive to the built-in exclusions.
   *
   * Accepts a glob (`scratch/**`) or a bare directory name with or without a
   * trailing slash (`scratch`, `scratch/`), which covers the whole subtree — see
   * {@link expandExcludePattern}. A pattern that matches nothing comes back in
   * {@link TreeCopyResult.unusedExcludePatterns}; it is never silently ignored.
   */
  exclude?: string[];
  /**
   * Sink for notices about INPUTS this copy ignored — currently only a
   * per-plugin `marketplace.json`, which VAT generates at the marketplace level.
   *
   * Deliberately NOT the channel for anything about what shipped. A `warn`
   * string can only ever become a log line, and a file vanishing from a bundle
   * has to reach the build's `issueCounts` or a CI consumer reads `warnings: 0`
   * for a build that shipped less than the config asked for. Facts about the
   * copied set are RETURNED (see {@link TreeCopyResult}) so the caller can
   * materialize them as coded findings.
   */
  warn?: (message: string) => void;
}

export interface TreeCopyResult {
  commandsCopied: number;
  hooksCopied: number;
  agentsCopied: number;
  mcpCopied: number;
  filesCopied: number;
  /**
   * Caller `exclude:` patterns that matched no file in this copy, in the order
   * the author wrote them and spelled exactly as authored.
   *
   * Returned rather than logged: zero matches means the knob no-oped, which is a
   * finding about the delta between the declared config and the shipped bundle —
   * the caller turns each into a coded issue that reaches `issueCounts`. Empty
   * (never `undefined`) when every pattern did work, so the caller never has to
   * distinguish "no dead patterns" from "this lane doesn't report them".
   */
  unusedExcludePatterns: string[];
}

/**
 * Built-in exclusions for the verbatim plugin copy.
 *
 * The agent-instruction list ONLY. `NEVER_PACKAGE_IN_SKILL_BUNDLE` also carries
 * the navigation patterns, and importing that here would strip the front page off
 * three in five real plugins: 57 of 94 installed plugins ship a plugin-root
 * `README.md`, and `copyDistributionFiles` copies READMEs to the marketplace root
 * on purpose. A README is vestigial *inside a skill bundle* and load-bearing at a
 * plugin root — that asymmetry is why the two lists must stay separate.
 */
const EXCLUDE_PATTERNS = [
  '.claude-plugin/**',
  ...toAnyDepthGlobs(AGENT_INSTRUCTION_FILE_PATTERNS),
];

/**
 * picomatch options for caller `exclude:` patterns.
 *
 * `dot: true` matches the crawler's own compilation ({@link crawlDirectory}) —
 * without it an exclude aimed at a dot-directory silently never fires, and the
 * two matchers in this one function would disagree about the same pattern.
 */
const PICOMATCH_OPTIONS = { dot: true } as const;

/** One caller-supplied `exclude:` pattern, its compiled matcher, and its hit count. */
interface ExcludeMatcher {
  /** The pattern exactly as the author wrote it — what any warning must quote. */
  pattern: string;
  isMatch: (relativePath: string) => boolean;
  hits: number;
}

/**
 * Expand one `exclude:` pattern into the spellings that make a directory-shaped
 * pattern mean the same thing in both crawl lanes.
 *
 * `crawlDirectory`'s `git ls-files` fast path only ever yields FILE paths, so a
 * bare `scratch` (or `scratch/`) matched nothing there, while the non-git walker
 * prunes directories and did match. Same config, opposite result, decided by
 * whether the plugin source happens to sit in a git repo — and the git case is
 * the one that ships. A non-glob pattern is therefore expanded to itself PLUS its
 * subtree; a pattern that is already a glob is passed through untouched.
 *
 * A bare FILE name (`keep.md`) also picks up a `keep.md/**` spelling, which
 * matches nothing — harmless, and cheaper than guessing file-vs-directory from
 * the string.
 */
function expandExcludePattern(pattern: string): string[] {
  // Hand-rolled rather than /\/+$/ — a trailing-repetition regex on caller input
  // is the shape sonarjs/slow-regex rejects, and this cannot backtrack.
  let trimmed = pattern;
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed === '' || isGlob(trimmed)) {
    return [pattern];
  }
  return [trimmed, `${trimmed}/**`];
}

/** Compile the caller's `exclude:` patterns into hit-counting matchers. */
function buildExcludeMatchers(patterns: readonly string[]): ExcludeMatcher[] {
  return patterns.map((pattern) => ({
    pattern,
    isMatch: picomatch(expandExcludePattern(pattern), PICOMATCH_OPTIONS),
    hits: 0,
  }));
}

/**
 * Does any caller `exclude:` pattern claim this path? Records a hit on EVERY
 * matching pattern (not just the first) so the zero-match warning below cannot
 * accuse a pattern that is genuinely doing work but is shadowed by another.
 */
function isExcludedByCaller(rel: string, matchers: ExcludeMatcher[]): boolean {
  let excluded = false;
  for (const matcher of matchers) {
    if (matcher.isMatch(rel)) {
      matcher.hits += 1;
      excluded = true;
    }
  }
  return excluded;
}

/**
 * The per-kind counter buckets, named explicitly rather than derived by omission
 * from {@link TreeCopyResult}: the result also carries non-numeric fields, and an
 * `Omit<…, 'filesCopied'>` silently swept the next one into the `+= 1` below.
 */
type CountedBucket = 'commandsCopied' | 'hooksCopied' | 'agentsCopied' | 'mcpCopied';

function classifyRelative(rel: string): CountedBucket | undefined {
  if (rel.startsWith('commands/')) return 'commandsCopied';
  if (rel.startsWith('hooks/')) return 'hooksCopied';
  if (rel.startsWith('agents/')) return 'agentsCopied';
  if (rel === '.mcp.json') return 'mcpCopied';
  return undefined;
}

export async function treeCopyPlugin(options: TreeCopyOptions): Promise<TreeCopyResult> {
  const { sourceDir, destDir, excludeSkillDirs = [], exclude: callerExclude = [], warn } = options;
  const result: TreeCopyResult = {
    commandsCopied: 0,
    hooksCopied: 0,
    agentsCopied: 0,
    mcpCopied: 0,
    filesCopied: 0,
    unusedExcludePatterns: [],
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourceDir resolved from config
  if (!existsSync(sourceDir)) {
    return result;
  }

  const authorMarketplaceJson = safePath.join(sourceDir, '.claude-plugin', 'marketplace.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (existsSync(authorMarketplaceJson) && warn) {
    warn(
      `Ignoring ${toForwardSlash(authorMarketplaceJson)}: marketplace.json is VAT-generated ` +
        `at the marketplace level and cannot be supplied per-plugin.`,
    );
  }

  const exclude = [
    ...EXCLUDE_PATTERNS,
    ...excludeSkillDirs.flatMap((name) => expandExcludePattern(`skills/${name}`)),
  ];

  const files = await crawlDirectory({
    baseDir: sourceDir,
    include: ['**/*'],
    exclude,
    absolute: true,
    filesOnly: true,
    respectGitignore: true,
  });

  // Caller `exclude:` patterns are applied HERE rather than handed to the crawl,
  // for two reasons: the two crawl lanes disagree about directory-shaped patterns
  // (see expandExcludePattern), and a pattern that matches nothing must be
  // reportable — a file the crawl never returns is a drop nothing can observe.
  const excludeMatchers = buildExcludeMatchers(callerExclude);

  for (const absPath of files) {
    const rel = toForwardSlash(safePath.relative(sourceDir, absPath));
    if (isExcludedByCaller(rel, excludeMatchers)) {
      continue;
    }
    const target = safePath.join(destDir, rel);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest resolved from sourceDir+relative
    await mkdir(dirname(target), { recursive: true });
    await copyFile(absPath, target);
    result.filesCopied += 1;

    const bucket = classifyRelative(rel);
    if (bucket) {
      result[bucket] += 1;
    }
  }

  // A typo'd or wrong-shaped exclude pattern used to be perfectly silent: the
  // knob no-oped and the junk shipped anyway. Zero matches is the only evidence
  // the author can get, so it always leaves this function — as DATA, on the one
  // channel the caller can count, not as a log line beside `warnings: 0`.
  result.unusedExcludePatterns = excludeMatchers
    .filter((matcher) => matcher.hits === 0)
    .map((matcher) => matcher.pattern);

  return result;
}
