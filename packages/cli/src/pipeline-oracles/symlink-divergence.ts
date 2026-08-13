/**
 * The symlink divergence report — what the three possible enumerations of one
 * corpus actually contain, and why each of them differs from the others.
 *
 * `followSymlinks` is not one decision. It is three, collapsed into a boolean:
 *
 * - **Loops and aliases.** A symlinked directory can be re-entered without
 *   limit and can be reached under two names. `crawlDirectory` now bounds this
 *   with a visited-realpath set; before that guard one file behind `a/loop -> a`
 *   enumerated sixteen times, terminating only when the kernel refused further
 *   symlink resolution — a limit that is 32 on macOS and 40 on Linux, so the
 *   POPULATION depended on the operating system.
 * - **Escaping the crawl root.** A link whose target lies outside `baseDir`
 *   widens the corpus to somewhere nobody pointed the command at. That matters
 *   most for `vat audit`, which runs over third-party plugin trees.
 * - **Membership.** Whether a symlinked *file* is part of the corpus at all.
 *
 * Only the third is a product question, and it is the one the boolean answers
 * least well: the flag is honoured on the `readdirSync` walk and ignored by
 * `git ls-files`, so the same tree with the same options has a different
 * population depending on whether a `.git` exists above it. This report exists
 * to make that concrete before the behaviour is converged, rather than picking
 * a direction from first principles.
 *
 * ## It reports rather than decides
 *
 * Judgement belongs in phase 4. Every row here is an observation with the
 * reason it diverged attached, so the eventual policy is chosen against
 * measured populations on real corpora.
 *
 * ## Two confounds, surfaced rather than silently removed
 *
 * Forcing the walk route means `respectGitignore: false`, which also stops
 * honouring `.gitignore` — so a naive git-vs-walk diff conflates route with
 * ignore semantics. And `git ls-files` returns only TRACKED files, so an
 * untracked-but-not-ignored file appears on the walk for reasons that have
 * nothing to do with symlinks. Both are classified explicitly
 * ({@link DivergenceClass}) instead of being filtered away, because a
 * difference removed before it is counted is a difference nobody can audit.
 */

import { realpathSync } from 'node:fs';

import { relativize } from '@vibe-agent-toolkit/resources';
import {
  crawlDirectory,
  GitTracker,
  gitFindRoot,
  isAbsolutePath,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import type { LaneDefinition } from './lanes.js';
import type { LaneId } from './types.js';

/** Why one path appears in some enumerations of a corpus and not others. */
export type DivergenceClass =
  /** Returned by `git ls-files` but dropped by the walk — a committed symlink. */
  | 'git-only'
  /** Appears only once symlinks are followed — the off-git growth case. */
  | 'follow-only'
  /** On the walk but not tracked by git; nothing to do with symlinks. */
  | 'untracked-only'
  /** Its real path is also reached under a different enumerated path. */
  | 'alias'
  /** Its real path lies outside the corpus root. */
  | 'escapes-root';

/** One diverging path, with every reason it diverged. */
export interface DivergenceRow {
  /** Path as enumerated, relative to the corpus root. */
  path: string;
  /** Real path, relativized when inside the root and left absolute when not. */
  realPath: string;
  /** Every class that applies. A single path routinely earns several. */
  classes: DivergenceClass[];
}

/** The three populations one corpus can present, and their differences. */
export interface SymlinkDivergenceReport {
  laneId: LaneId;
  /** Label naming the corpus in the report. */
  corpus: string;
  /** True when a `.git` exists above the corpus root. */
  inGitRepo: boolean;
  counts: {
    /** `git ls-files` route. Null when the corpus is not in a repository. */
    gitRoute: number | null;
    /** Forced walk, symlinks skipped — today's default off-git. */
    walkNoFollow: number;
    /** Forced walk, symlinks followed. */
    walkFollow: number;
  };
  /** Every path that is not in all available populations, sorted by path. */
  rows: DivergenceRow[];
}

/**
 * Capture the three enumerations of one corpus through one lane, and diff them.
 *
 * Sorted, unlike the enumeration snapshot: this report answers "which paths
 * differ", a set question, and arrival order is meaningless across three
 * separately-ordered populations. The ordered question is the enumeration
 * snapshot's, and it stays there.
 *
 * @param lane - Lane whose crawl options define the include/exclude set
 * @param options - Corpus root and the label to record
 * @returns The divergence report
 *
 * @example
 * ```typescript
 * const report = await captureSymlinkDivergence(laneById('audit'), {
 *   corpusRoot: corpus,
 *   corpus: 'trap-corpus/git',
 * });
 * ```
 */
export async function captureSymlinkDivergence(
  lane: LaneDefinition,
  options: { corpusRoot: string; corpus: string },
): Promise<SymlinkDivergenceReport> {
  const corpusRoot = safePath.resolve(options.corpusRoot);
  const base = lane.crawlOptions(corpusRoot);
  const inGitRepo = gitFindRoot(corpusRoot) !== null;

  const gitRoute = inGitRepo ? await crawlDirectory({ ...base, respectGitignore: true }) : null;
  const walkNoFollow = await crawlDirectory({
    ...base,
    respectGitignore: false,
    followSymlinks: false,
  });
  const walkFollow = await crawlDirectory({
    ...base,
    respectGitignore: false,
    followSymlinks: true,
  });

  const tracker = inGitRepo ? await usableTracker(corpusRoot) : undefined;
  const gitSet = gitRoute === null ? null : new Set(gitRoute.map((p) => relativize(p, corpusRoot)));
  const noFollowSet = new Set(walkNoFollow.map((p) => relativize(p, corpusRoot)));

  // Real paths across the widest population, so aliasing is answered against
  // everything the corpus can present rather than against one arm of it.
  const realPaths = new Map<string, string>();
  const realPathCounts = new Map<string, number>();
  for (const absolutePath of walkFollow) {
    const real = realPathOrSelf(absolutePath);
    realPaths.set(absolutePath, real);
    realPathCounts.set(real, (realPathCounts.get(real) ?? 0) + 1);
  }

  const everyPath = new Set<string>([
    ...(gitRoute ?? []),
    ...walkNoFollow,
    ...walkFollow,
  ]);

  const rows: DivergenceRow[] = [];
  for (const absolutePath of everyPath) {
    const path = relativize(absolutePath, corpusRoot);
    const real = realPaths.get(absolutePath) ?? realPathOrSelf(absolutePath);
    const classes = classify({
      path,
      absolutePath,
      real,
      corpusRoot,
      gitSet,
      noFollowSet,
      isAlias: (realPathCounts.get(real) ?? 0) > 1,
      isIgnored: tracker?.isIgnored(absolutePath) ?? false,
    });

    if (classes.length > 0) {
      rows.push({ path, realPath: relativizeReal(real, corpusRoot), classes });
    }
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));

  return {
    laneId: lane.id,
    corpus: options.corpus,
    inGitRepo,
    counts: {
      gitRoute: gitRoute?.length ?? null,
      walkNoFollow: walkNoFollow.length,
      walkFollow: walkFollow.length,
    },
    rows,
  };
}

/** Everything needed to decide why one path diverged. */
interface ClassifyInput {
  path: string;
  absolutePath: string;
  real: string;
  corpusRoot: string;
  gitSet: Set<string> | null;
  noFollowSet: Set<string>;
  isAlias: boolean;
  isIgnored: boolean;
}

/**
 * Name every reason a path is not present in all available populations.
 *
 * @param input - The path and the populations to judge it against
 * @returns Applicable classes; empty when the path is in every population and
 *   is neither an alias nor an escape
 */
function classify(input: ClassifyInput): DivergenceClass[] {
  const classes: DivergenceClass[] = [];
  const inGit = input.gitSet?.has(input.path) ?? null;
  const inNoFollow = input.noFollowSet.has(input.path);

  if (inGit === true && !inNoFollow) {
    classes.push('git-only');
  }
  if (!inNoFollow && inGit !== true) {
    // Present only once symlinks are followed. An ignored file is excluded:
    // it is absent from the git route for ignore reasons, not symlink ones.
    classes.push('follow-only');
  }
  if (inGit === false && inNoFollow && !input.isIgnored) {
    classes.push('untracked-only');
  }
  if (input.isAlias) {
    classes.push('alias');
  }
  if (!isInside(input.real, input.corpusRoot)) {
    classes.push('escapes-root');
  }

  return classes;
}

/**
 * Resolve a path's real location, falling back to the path itself.
 *
 * A dangling symlink cannot be resolved, and that is a corpus fact rather than
 * a harness error — reporting the link's own path keeps the row in the report
 * instead of dropping the one entry most likely to be interesting.
 *
 * @param absolutePath - Path to resolve
 * @returns The real path, or the input when it cannot be resolved
 */
function realPathOrSelf(absolutePath: string): string {
  try {
    return toForwardSlash(realpathSync.native(absolutePath));
  } catch {
    return toForwardSlash(absolutePath);
  }
}

/**
 * Is a real path inside the corpus root?
 *
 * @param real - Forward-slashed real path
 * @param corpusRoot - Corpus root
 * @returns True when the path lies within the root
 */
function isInside(real: string, corpusRoot: string): boolean {
  const rel = safePath.relative(corpusRoot, real);
  return rel !== '' && !rel.startsWith('..') && !isAbsolutePath(rel);
}

/**
 * Render a real path for the report.
 *
 * Paths inside the root are relativized so the report is machine-independent;
 * paths outside it stay absolute, because "where did this escape to" is the
 * whole content of that row. Callers that publish a report from a real corpus
 * are responsible for redacting those.
 *
 * @param real - Forward-slashed real path
 * @param corpusRoot - Corpus root
 * @returns Relative path when inside the root, absolute when outside
 */
function relativizeReal(real: string, corpusRoot: string): string {
  return isInside(real, corpusRoot) ? relativize(real, corpusRoot) : real;
}

/**
 * Build a git oracle for the corpus, or report that there is none.
 *
 * @param corpusRoot - Absolute corpus root
 * @returns An initialized tracker, or undefined when git cannot answer
 */
async function usableTracker(corpusRoot: string): Promise<GitTracker | undefined> {
  const tracker = new GitTracker(corpusRoot);
  await tracker.initialize();
  return tracker.isUsable() ? tracker : undefined;
}
