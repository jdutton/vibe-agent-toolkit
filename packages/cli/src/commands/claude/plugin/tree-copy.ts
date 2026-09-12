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
 * Symlinks are judged before anything is copied, identically on both crawl
 * routes: an in-tree FILE symlink is copied by content and reported; one that
 * leaves the source, does not resolve, or names a directory stops the copy by
 * name ({@link PluginSymlinkRefusedError}) before the first byte lands.
 *
 * Respects .gitignore via crawlDirectory (respectGitignore: true, the default).
 * Returns counts keyed to the spec's YAML summary extension.
 */

import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AGENT_INSTRUCTION_FILE_PATTERNS, toAnyDepthGlobs } from '@vibe-agent-toolkit/agent-skills';
import { isGlob, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectory, crawlPathFilter, refuseListing } from '@vibe-agent-toolkit/utils/crawl';
import { gitFindRoot } from '@vibe-agent-toolkit/utils/git';
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
  /**
   * Root-relative paths of the in-tree FILE symlinks this copy resolved and
   * copied BY CONTENT (each is also counted in `filesCopied`), in copy order.
   *
   * The tell for the one symlink shape that ships. A bundle is a plain tree —
   * there is no symlink-preserving copy — so the target's bytes travel under the
   * link's name; the caller can say so. Every other shape (a link out of the
   * source, a dangling one, a directory link) is refused by name before the
   * first copy: see {@link PluginSymlinkRefusedError}. Empty (never `undefined`)
   * when the source holds no symlinks.
   */
  symlinksCopied: string[];
}

/** Why one symlink in the plugin source cannot be shipped. */
export type SymlinkRefusalReason =
  /** Its target is outside the plugin source — the bundle would carry a file from elsewhere on the build host. */
  | 'escapes-source'
  /** It does not resolve: dangling, or a self-referential loop. */
  | 'unresolvable'
  /** It resolves to a directory (inside the source). */
  | 'directory';

/** One refused symlink: where it is in the source, and why it cannot ship. */
export interface RefusedSymlink {
  /** Root-relative, forward-slashed — the spelling the adopter's `exclude:` would name. */
  path: string;
  reason: SymlinkRefusalReason;
}

const REFUSAL_REASON_TEXT: Record<SymlinkRefusalReason, string> = {
  'escapes-source': 'points outside the plugin source, so the bundle would carry a file from elsewhere on the build host',
  unresolvable: 'does not resolve to anything (dangling, or a loop)',
  directory: 'is a directory symlink; a bundle is a plain tree and cannot carry a directory alias',
};

/**
 * The copy stopped because the plugin source holds symlinks that cannot ship.
 *
 * The sibling of the listing refusal (`DirectoryListingRefusedError` from the
 * crawl): thrown BEFORE the first byte is copied, with every offender named,
 * so a failing build leaves no half-written bundle and the operator fixes the
 * whole list in one pass. Measured before this existed: on the git route a
 * directory or dangling symlink threw a raw `ENOTSUP` / `ENOENT` out of
 * `copyFile` after earlier files had already landed, and a file symlink out of
 * the source was copied by content with no diagnostic at all; on the walk route
 * every symlink was silently dropped.
 *
 * The message speaks the bundle's coordinates (root-relative paths), never the
 * build host's absolute paths, and names the remedy — the `exclude:` knob — in
 * the same terms the listing refusal does.
 */
export class PluginSymlinkRefusedError extends Error {
  readonly refused: readonly RefusedSymlink[];

  constructor(refused: readonly RefusedSymlink[]) {
    const lines = refused.map((entry) => `  - '${entry.path}' ${REFUSAL_REASON_TEXT[entry.reason]}`);
    super(
      `Refusing to copy the plugin source: ${refused.length} symbolic link(s) cannot be shipped in a bundle,`
        + ` so nothing was copied.\n${lines.join('\n')}\n`
        + 'Replace each link with the file it points at, or name it in the plugin\'s `exclude:` list to leave'
        + ' it out of the bundle deliberately.',
    );
    this.name = 'PluginSymlinkRefusedError';
    this.refused = refused;
  }
}

/**
 * Built-in exclusions for the verbatim plugin copy.
 *
 * The agent-instruction list ONLY. `NEVER_PACKAGE_IN_SKILL_BUNDLE` also carries
 * the navigation patterns, and importing that here would strip the front page off
 * three in five real plugins: measured 2026-08-02, 50 of 86 installed plugins ship
 * a plugin-root `README.md` (57 of 94 when first measured — the population moves as
 * plugins come and go; the ratio is what carries the argument, so re-measure rather
 * than cite this as current), and `copyDistributionFiles` copies READMEs to the marketplace root
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

/** One path the copy considers: where it is, and its spelling inside the bundle. */
interface SourceEntry {
  abs: string;
  rel: string;
}

/**
 * Split the crawl's paths into regular files and symlinks by `lstat`, on BOTH
 * routes — this is the one predicate the two crawl lanes share. The walker
 * never yields a symlink (see {@link sweepSymlinks}), so there it finds none;
 * `git ls-files` yields every tracked symlink as an ordinary path, so there it
 * is what stops `copyFile` from being the first thing to notice.
 */
async function partitionByLstat(
  sourceDir: string,
  files: readonly string[],
): Promise<{ regular: SourceEntry[]; links: SourceEntry[] }> {
  const regular: SourceEntry[] = [];
  const links: SourceEntry[] = [];
  for (const abs of files) {
    const entry = { abs, rel: toForwardSlash(safePath.relative(sourceDir, abs)) };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path returned by the crawl of sourceDir
    const info = await lstat(abs);
    (info.isSymbolicLink() ? links : regular).push(entry);
  }
  return { regular, links };
}

/**
 * Every symlink under `sourceDir` that the exclude list admits — the half of the
 * population the walk route cannot see.
 *
 * `crawlDirectory`'s walker skips every symlink entry unless `followSymlinks`
 * is set, and following would not do either: a directory link would be
 * traversed (its contents yielded under the link's name) and a dangling one
 * silently skipped as absence. Neither is "here is a symlink, decide". So on
 * the walk route this pass lists them itself, with the SAME membership filter
 * the crawl applied, and hands each one to the same judgement the git route's
 * tracked symlinks get. A directory that will not list is not swallowed here:
 * the crawl has already refused it by name before this runs.
 *
 * Only the walk route needs it. Inside a repository `git ls-files` already
 * yields the tracked symlinks, and a sweep there would also find IGNORED ones
 * (`node_modules/.bin/*` is nothing but symlinks) and refuse a bundle for links
 * the crawl had correctly left out. The route is read the way the crawl reads
 * it — is there a repository above `sourceDir` — with one gap: a repository
 * whose `git ls-files` fails makes the crawl fall back to the walker, and that
 * run gets no sweep. A repository with no working `git` already hard-fails the
 * default scan elsewhere, so the gap is not widened here.
 */
async function sweepSymlinks(
  sourceDir: string,
  isMember: (relativePath: string) => boolean,
): Promise<SourceEntry[]> {
  const found: SourceEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking beneath the validated sourceDir
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = safePath.join(dir, entry.name);
      const rel = toForwardSlash(safePath.relative(sourceDir, abs));
      if (!isMember(rel)) continue;
      if (entry.isSymbolicLink()) {
        found.push({ abs, rel });
      } else if (entry.isDirectory()) {
        await walk(abs);
      }
    }
  };
  await walk(sourceDir);
  return found;
}

/** Is `real` the source root itself, or beneath it? Both sides canonical. */
function isUnderSource(real: string, realSource: string): boolean {
  return real === realSource || real.startsWith(`${realSource}/`);
}

/**
 * Judge one symlink: the one shape that ships (`'file'`, in-tree, copied by
 * content) or the reason it cannot.
 */
async function classifySymlink(abs: string, realSource: string): Promise<SymlinkRefusalReason | 'file'> {
  let real: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a symlink the crawl of sourceDir returned
    real = toForwardSlash(await realpath(abs));
  } catch {
    return 'unresolvable';
  }
  if (!isUnderSource(real, realSource)) return 'escapes-source';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonical path proven to sit under sourceDir
  return (await stat(real)).isDirectory() ? 'directory' : 'file';
}

/**
 * Judge every symlink and split them: the ones that ship, and the ones that
 * stop the copy. Sorted by path so the refusal reads the same on every
 * filesystem — `readdir` order is not stable across platforms.
 */
async function judgeSymlinks(
  sourceDir: string,
  links: readonly SourceEntry[],
): Promise<{ copyable: SourceEntry[]; refused: RefusedSymlink[] }> {
  const copyable: SourceEntry[] = [];
  const refused: RefusedSymlink[] = [];
  if (links.length === 0) return { copyable, refused };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourceDir resolved from config
  const realSource = toForwardSlash(await realpath(sourceDir));
  for (const link of [...links].toSorted((a, b) => a.rel.localeCompare(b.rel))) {
    const verdict = await classifySymlink(link.abs, realSource);
    if (verdict === 'file') {
      copyable.push(link);
    } else {
      refused.push({ path: link.rel, reason: verdict });
    }
  }
  return { copyable, refused };
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
    symlinksCopied: [],
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

  // A directory the crawl cannot LIST stops the copy, by name. The alternative —
  // enumerate around it and copy what was seen — ships a plugin missing every
  // file beneath that directory while the build reports success, which is the
  // silent-drop shape this whole function is built to refuse (see the
  // zero-match report below). Refusing here also runs BEFORE the first copy,
  // so a build that fails leaves no half-written bundle to be mistaken for one.
  // Only the walk route lists directories; inside a repository `git ls-files`
  // answers and a refusal surfaces on the file copy instead.
  const files = await crawlDirectory({
    baseDir: sourceDir,
    include: ['**/*'],
    exclude,
    absolute: true,
    filesOnly: true,
    respectGitignore: true,
    onUnreadable: refuseListing({
      root: sourceDir,
      remedy:
        'Fix the permissions on that directory, or name it in the plugin\'s `exclude:` list to leave it out of the bundle deliberately.',
    }),
  });

  // Caller `exclude:` patterns are applied HERE rather than handed to the crawl,
  // for two reasons: the two crawl lanes disagree about directory-shaped patterns
  // (see expandExcludePattern), and a pattern that matches nothing must be
  // reportable — a file the crawl never returns is a drop nothing can observe.
  const excludeMatchers = buildExcludeMatchers(callerExclude);
  const notExcludedByCaller = (entry: SourceEntry): boolean => !isExcludedByCaller(entry.rel, excludeMatchers);

  // Symlinks are decided BEFORE the first copy, on both routes, and by one
  // judgement (see classifySymlink). The two lanes used to disagree twice over:
  // the walker dropped every symlink silently, while `git ls-files` handed them
  // to `copyFile`, which followed a link out of the source (shipping a file from
  // elsewhere on the build host) and threw a raw errno on a directory or
  // dangling one after earlier files had already landed. Collect first, judge,
  // then copy — the same shape as the listing refusal above, so a build that
  // fails on a symlink leaves no half-written bundle either.
  const { regular, links: crawledLinks } = await partitionByLstat(sourceDir, files);
  const links = gitFindRoot(sourceDir) === null
    ? [...crawledLinks, ...(await sweepSymlinks(sourceDir, crawlPathFilter(['**/*'], exclude)))]
    : crawledLinks;
  // A link the caller excluded is left out like any other excluded path — and
  // that is the remedy the refusal names, so it must count as a hit here.
  const { copyable, refused } = await judgeSymlinks(sourceDir, links.filter(notExcludedByCaller));
  if (refused.length > 0) {
    throw new PluginSymlinkRefusedError(refused);
  }

  for (const entry of [...regular.filter(notExcludedByCaller), ...copyable]) {
    const target = safePath.join(destDir, entry.rel);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest resolved from sourceDir+relative
    await mkdir(dirname(target), { recursive: true });
    // `copyFile` follows a symlink, which is the point for the in-tree file
    // links that reach here: the bundle carries the target's bytes.
    await copyFile(entry.abs, target);
    result.filesCopied += 1;

    const bucket = classifyRelative(entry.rel);
    if (bucket) {
      result[bucket] += 1;
    }
  }
  result.symlinksCopied = copyable.map((entry) => entry.rel);

  // A typo'd or wrong-shaped exclude pattern used to be perfectly silent: the
  // knob no-oped and the junk shipped anyway. Zero matches is the only evidence
  // the author can get, so it always leaves this function — as DATA, on the one
  // channel the caller can count, not as a log line beside `warnings: 0`.
  result.unusedExcludePatterns = excludeMatchers
    .filter((matcher) => matcher.hits === 0)
    .map((matcher) => matcher.pattern);

  return result;
}
