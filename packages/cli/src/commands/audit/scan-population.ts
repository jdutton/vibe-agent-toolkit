/**
 * The population `vat audit <directory>` validates, enumerated through the
 * `crawl` lane.
 *
 * This module replaced a ~700-line recursive `fs.readdir` walk that lived in
 * `audit.ts` with its own gitignore map, its own skip reasons and its own
 * unreadable-directory handling — a fifth enumeration lane
 * `docs/contributing/command-lane-table.md` used to deny existed. The audit's
 * population is now what `crawlDirectory` returns, narrowed to the four file
 * shapes the audit knows how to validate, so a change to the lane's narrowings
 * (`NEVER_CRAWL_GLOBS`, the git route, the refusal policy) reaches `vat audit`
 * like every other row of that table.
 *
 * Two halves, deliberately: {@link enumerateAuditPopulation} asks the lane and
 * is exercised by an integration test over a real tree;
 * {@link classifyScanPopulation} turns a flat listing into ordered subjects and
 * is pure, so the part that used to be interleaved with `readdir` has unit
 * tests of its own.
 */

import { findProjectRoot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectory, type DirectoryRefusal, NEVER_CRAWL_GLOBS } from '@vibe-agent-toolkit/utils/crawl';
import picomatch from 'picomatch';

import { loadConfig } from '../../utils/config-loader.js';

/** The project config the audit walks UP to, and announces when it meets one NESTED in the tree. */
export const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
/** The two Claude registry files the audit validates wherever it finds them. */
const REGISTRY_FILE_NAMES: ReadonlySet<string> = new Set(['installed_plugins.json', 'known_marketplaces.json']);
const SKILL_MANIFEST = 'SKILL.md';
/** A directory holding this one is a plugin (or a marketplace) — the unified validator decides which. */
const PLUGIN_MARKER_DIR = '.claude-plugin';

/**
 * What the crawl is asked for. Everything else in the tree is not the audit's
 * business, and asking for it only makes the git route filter more.
 */
const SUBJECT_INCLUDE: readonly string[] = [
  `**/${SKILL_MANIFEST}`,
  '**/installed_plugins.json',
  '**/known_marketplaces.json',
  `**/${PLUGIN_MARKER_DIR}/*`,
  `**/${VAT_CONFIG_FILENAME}`,
];

/**
 * `--no-recursive`: the root's own files plus the plugin marker of each
 * immediate subdirectory — which is what a one-level `readdir` used to see
 * (a subdirectory is a plugin when `.claude-plugin/` is inside it, so that one
 * marker directory is looked into and nothing else is).
 */
const TOP_LEVEL_INCLUDE: readonly string[] = ['*', `*/${PLUGIN_MARKER_DIR}/*`];
/** Prunes every subdirectory's subtree except the marker directory — see {@link TOP_LEVEL_INCLUDE}. */
const TOP_LEVEL_PRUNE = `*/!(${PLUGIN_MARKER_DIR})/**/*`;

/** One thing the audit validates, found by the directory lane. */
export type AuditScanSubject =
  /** A directory holding `.claude-plugin/` — a plugin or a marketplace. */
  | { readonly kind: 'plugin'; readonly dir: string }
  /** A `SKILL.md`; `dir` is the skill directory. */
  | { readonly kind: 'skill'; readonly dir: string; readonly path: string }
  /** An `installed_plugins.json` / `known_marketplaces.json`. */
  | { readonly kind: 'registry'; readonly dir: string; readonly path: string };

/**
 * A compiled exclude rule plus the base its patterns are relative to.
 *
 * Audit applies two exclude sources with DIFFERENT bases, which is why the base
 * travels with the matcher instead of being assumed. `--exclude` is typed at the
 * command line about the directory the operator named, so it is relative to the
 * scan base. `resources.exclude` is written in a config file about that config's
 * own project, so it is relative to the project root — matching it against
 * scan-relative paths makes one config mean different things depending on which
 * subdirectory you happened to name.
 */
export interface ExcludeMatcher {
  readonly isMatch: (relativePath: string) => boolean;
  /** The directory the patterns are relative to — the scan root for `--exclude`, the project root for `resources.exclude`. */
  readonly base: string;
}

/** The two channels the population's own diagnostics go out on. */
export interface ScanLogger {
  warn(message: string): void;
  debug(message: string): void;
}

/**
 * Compile the governing project's `resources.exclude` for a scan.
 *
 * The config is found by walking UP from the scan directory ({@link findProjectRoot}),
 * not by looking in it. Looking only in the scan directory is how a path argument
 * silently voided every exclude the project had declared: `vat audit
 * packages/x/resources/skills/` found no config there, so a package that excludes
 * its deliberately-broken eval fixtures had them audited as production skills the
 * moment anyone named a subdirectory. The rule: a path argument says WHICH tree
 * to audit, and `exclude` applies either way.
 *
 * With one deliberate exception, mirroring the gitignore rule the scan context
 * applies: when the operator points the scan AT an excluded tree, their explicit
 * intent wins and the excludes are dropped for that run. Otherwise naming an
 * excluded directory would report `filesScanned: 0, status: success` — a green
 * run that scanned nothing.
 *
 * @param scanDir - The audited directory
 * @param logger - `warn` for a config that would not load, `debug` for the scan-root exception
 * @returns The compiled matcher, or `null` when nothing applies
 */
export function resolveProjectExcludes(scanDir: string, logger: ScanLogger): ExcludeMatcher | null {
  const projectRoot = findProjectRoot(scanDir);
  if (projectRoot === null) return null;

  let patterns: readonly string[];
  try {
    patterns = loadConfig(projectRoot)?.resources?.exclude ?? [];
  } catch (err) {
    // Audit is a bulk linter over trees it does not own; a broken governing
    // config must not abort the scan. `warn`, not `debug`: EVERY
    // `resources.exclude` the project declared is void for this run, so a
    // package that excludes its deliberately-broken eval fixtures has them
    // audited as production skills — findings APPEARING, which an operator
    // reads as VAT being wrong rather than as their config being broken.
    logger.warn(
      `Config at ${projectRoot} could not be read; every resources.exclude it declares is`
      + ` dropped for this run, so excluded trees are audited as ordinary source: ${String(err)}`,
    );
    return null;
  }
  if (patterns.length === 0) return null;

  // dot:true so excludes like `**/.cache/*` match through dotfile dirs;
  // without it the exclude silently never fires.
  const isMatch = picomatch([...patterns], { dot: true });
  const scanRelToProject = toForwardSlash(safePath.relative(projectRoot, safePath.resolve(scanDir)));
  if (scanRelToProject !== '' && (isMatch(scanRelToProject) || isMatch(`${scanRelToProject}/`))) {
    logger.debug(
      `Scan root ${scanRelToProject} is excluded by the config at ${projectRoot}; ` +
        'auditing it anyway because it was named explicitly',
    );
    return null;
  }

  return { isMatch, base: projectRoot };
}

export interface AuditScanPopulation {
  /**
   * Every subject, in the order the recursive walk used to produce them: a
   * directory's own subjects (its plugin marker first, then its files by
   * name) before its subdirectories', subdirectories by name.
   */
  readonly subjects: readonly AuditScanSubject[];
  /**
   * Directories the lane could not list. Each is a gap — whatever was beneath
   * it is absent from `subjects` — and owes the reader a finding of its own.
   */
  readonly refusals: readonly DirectoryRefusal[];
  /** `vibe-agent-toolkit.config.yaml` files strictly beneath the scan root, in path order. */
  readonly nestedConfigs: readonly string[];
}

export interface AuditScanOptions {
  readonly scanDir: string;
  readonly recursive: boolean;
  /**
   * `true` answers from git (tracked + untracked-not-ignored) when the root is
   * inside a repository. `false` — `--include-artifacts`, or a scan root that
   * is itself gitignored — walks the tree and sees ignored files too; the
   * lane's own never-crawl list still applies on that route.
   */
  readonly respectGitignore: boolean;
  /** The operator's `--exclude` patterns, relative to `scanDir`. */
  readonly userExcludes: readonly string[];
  /** The governing project's `resources.exclude`, compiled against ITS root; `null` when there is none. */
  readonly projectExcludes: ExcludeMatcher | null;
}

/**
 * Is `absolutePath` dropped by `matcher` — by its own path, or by a directory
 * between the scan root and it?
 *
 * The walk this replaced pruned a directory the moment its base-relative path
 * matched (with the `+ '/'` retry that lets `dist/**` match the directory
 * `dist`), so nothing beneath it was ever listed. A flat listing has to ask the
 * same question of every ancestor, or a bare `vendor` pattern that used to
 * prune the directory stops excluding the files inside it. Ancestors strictly
 * below the scan root only: the scan root was cleared by the caller (naming an
 * excluded directory is the operator's intent), and anything above it was
 * never walked.
 *
 * @param matcher - The compiled patterns and the base they are relative to
 * @param scanDir - The audited directory; nothing at or above it is tested
 * @param absolutePath - The file to decide
 * @returns True when the file or one of its scan-relative ancestors matches
 */
export function isExcludedByMatcher(matcher: ExcludeMatcher, scanDir: string, absolutePath: string): boolean {
  const scanRoot = toForwardSlash(safePath.resolve(scanDir));
  const target = toForwardSlash(safePath.resolve(absolutePath));
  if (!target.startsWith(`${scanRoot}/`)) return false;

  // Every ancestor strictly below the scan root (each prefix ending at a
  // separator), then the file itself.
  for (const [candidate, isDirectory] of prefixesBelow(target, scanRoot.length + 1)) {
    const relative = toForwardSlash(safePath.relative(matcher.base, candidate));
    if (matcher.isMatch(relative) || (isDirectory && matcher.isMatch(`${relative}/`))) return true;
  }
  return false;
}

/**
 * The prefixes of a forward-slashed path that end at each separator past
 * `from`, each flagged as a directory, and finally the whole path flagged as
 * not one.
 */
function* prefixesBelow(path: string, from: number): Generator<readonly [string, boolean]> {
  for (let slash = path.indexOf('/', from); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    yield [path.slice(0, slash), true];
  }
  yield [path, false];
}

/** The directory of a scan-relative, forward-slashed path (`''` at the root). */
function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

/** The segments of a forward-slashed relative path. */
function segmentsOf(relativePath: string): string[] {
  const segments: string[] = [];
  let rest = relativePath;
  for (let slash = rest.indexOf('/'); slash !== -1; slash = rest.indexOf('/')) {
    segments.push(rest.slice(0, slash));
    rest = rest.slice(slash + 1);
  }
  segments.push(rest);
  return segments;
}

function basenameOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/** How many directories deep a scan-relative, forward-slashed path sits (a root file is 1). */
function depthOf(relativePath: string): number {
  let depth = 1;
  for (let slash = relativePath.indexOf('/'); slash !== -1; slash = relativePath.indexOf('/', slash + 1)) {
    depth += 1;
  }
  return depth;
}

/** Subjects at the root or the plugin marker of an immediate child — the `--no-recursive` population. */
function isTopLevel(relativePath: string, isMarkerFile: boolean): boolean {
  const depth = depthOf(relativePath);
  return isMarkerFile ? depth === 3 : depth === 1;
}

/** Relative directory + rank, so a directory's own subjects sort before its subdirectories'. */
interface SubjectKey {
  readonly dir: readonly string[];
  readonly rank: number;
  readonly name: string;
}

function sortKey(scanDir: string, subject: AuditScanSubject): SubjectKey {
  const dir = toForwardSlash(safePath.relative(scanDir, subject.dir));
  const segments = dir === '' ? [] : segmentsOf(dir);
  return subject.kind === 'plugin'
    ? { dir: segments, rank: 0, name: '' }
    : { dir: segments, rank: 1, name: basenameOf(toForwardSlash(subject.path)) };
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Depth-first pre-order over the directory tree: an ancestor's subjects come
 * before a descendant's, siblings compare by name, and within one directory
 * the plugin marker precedes the files.
 */
function compareSubjects(a: SubjectKey, b: SubjectKey): number {
  const shared = Math.min(a.dir.length, b.dir.length);
  for (let index = 0; index < shared; index++) {
    const byName = compareStrings(a.dir[index] ?? '', b.dir[index] ?? '');
    if (byName !== 0) return byName;
  }
  if (a.dir.length !== b.dir.length) return a.dir.length - b.dir.length;
  return a.rank - b.rank || compareStrings(a.name, b.name);
}

/**
 * Turn a flat enumeration into the audit's subjects.
 *
 * @param scanDir - The audited directory, absolute
 * @param relativePaths - Files the lane returned, scan-relative, forward-slashed
 * @param recursive - `false` keeps only the root's files and immediate subdirectories' plugin markers
 * @returns Ordered subjects and the nested configs the walk used to announce
 */
export function classifyScanPopulation(
  scanDir: string,
  relativePaths: readonly string[],
  recursive: boolean,
): { subjects: AuditScanSubject[]; nestedConfigs: string[] } {
  const pluginDirs = new Set<string>();
  const subjects: AuditScanSubject[] = [];
  const nestedConfigs: string[] = [];

  for (const raw of relativePaths) {
    const relativePath = toForwardSlash(raw);
    const name = basenameOf(relativePath);
    const dir = parentOf(relativePath);
    const isMarkerFile = basenameOf(dir) === PLUGIN_MARKER_DIR;
    if (!recursive && !isTopLevel(relativePath, isMarkerFile)) continue;

    if (isMarkerFile) {
      // The scan root's own marker is not this lane's: a root that IS a
      // plugin was dispatched to the plugin lane before any walk began, and
      // the walk only ever asked the question of the directories it entered.
      const pluginDir = parentOf(dir);
      if (pluginDir !== '') pluginDirs.add(pluginDir);
    } else if (name === SKILL_MANIFEST) {
      subjects.push({ kind: 'skill', dir: safePath.join(scanDir, dir), path: safePath.join(scanDir, relativePath) });
    } else if (REGISTRY_FILE_NAMES.has(name)) {
      subjects.push({ kind: 'registry', dir: safePath.join(scanDir, dir), path: safePath.join(scanDir, relativePath) });
    } else if (name === VAT_CONFIG_FILENAME && dir !== '') {
      nestedConfigs.push(safePath.join(scanDir, relativePath));
    }
  }
  for (const dir of pluginDirs) {
    subjects.push({ kind: 'plugin', dir: safePath.join(scanDir, dir) });
  }

  const keyed = subjects.map((subject) => ({ subject, key: sortKey(scanDir, subject) }));
  keyed.sort((a, b) => compareSubjects(a.key, b.key));
  nestedConfigs.sort((a, b) => compareStrings(toForwardSlash(a), toForwardSlash(b)));
  return { subjects: keyed.map(({ subject }) => subject), nestedConfigs };
}

/**
 * Enumerate the audit's population through the `crawl` lane.
 *
 * A refused directory is not thrown: `vat audit` is a bulk linter over trees it
 * does not own, and one root-owned directory under `~/.claude/plugins` must not
 * cost the run every finding beside it. It is handed back on `refusals`, and the
 * caller files it (the audit degrades, it never refuses the run).
 *
 * @param options - Where to look and what to leave out
 * @returns The ordered subjects, the refusals, and the nested configs
 */
export async function enumerateAuditPopulation(options: AuditScanOptions): Promise<AuditScanPopulation> {
  const { scanDir, recursive, respectGitignore, userExcludes, projectExcludes } = options;
  const refusals: DirectoryRefusal[] = [];
  const resolvedScanDir = safePath.resolve(scanDir);

  // The operator's `--exclude` is scan-relative, which is the lane's basis too,
  // so it prunes inside the crawl; the project's `resources.exclude` is
  // project-relative and is applied below, against every ancestor.
  const listed = await crawlDirectory({
    baseDir: resolvedScanDir,
    include: recursive ? [...SUBJECT_INCLUDE] : [...TOP_LEVEL_INCLUDE],
    exclude: [...NEVER_CRAWL_GLOBS, ...userExcludes, ...(recursive ? [] : [TOP_LEVEL_PRUNE])],
    respectGitignore,
    includeUntracked: true,
    absolute: false,
    unreadable: { degrade: (refusal) => refusals.push(refusal) },
  });

  const matchers: ExcludeMatcher[] = [];
  if (userExcludes.length > 0) {
    // Re-applied with the ancestor rule: on the git route the lane filters
    // FILES only, so a bare directory pattern that pruned the walk would
    // otherwise stop excluding what is inside that directory.
    matchers.push({ isMatch: picomatch([...userExcludes], { dot: true }), base: resolvedScanDir });
  }
  if (projectExcludes !== null) matchers.push(projectExcludes);

  const admitted = listed.filter((relativePath) =>
    !matchers.some((matcher) => isExcludedByMatcher(matcher, resolvedScanDir, safePath.join(resolvedScanDir, relativePath))));

  const { subjects, nestedConfigs } = classifyScanPopulation(resolvedScanDir, admitted, recursive);
  return { subjects, refusals, nestedConfigs };
}
