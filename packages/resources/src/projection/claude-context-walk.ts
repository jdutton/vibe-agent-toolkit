/**
 * The harness's LAUNCH WALK, replayed over the projection: which instruction
 * files and imports a session started in one directory loads before its first
 * turn, and in what order.
 *
 * ## Why a walk, and not a union of closures
 *
 * The query used to admit every closure rooted at an ancestor or a rule and
 * class each member by its ROOT. The shipped loader (`$yn` → `$q` → `Lke`,
 * transcribed in
 * [`docs/external/claude-code-memory-loader.md`](../../../../docs/external/claude-code-memory-loader.md))
 * does something no union of per-root closures reproduces:
 *
 * - it walks depth-first, with ONE visited set shared by the whole launch, and
 *   marks a file visited BEFORE reading it — so a file is loaded at most once,
 *   by whichever route reaches it first, and a later route finds it spent;
 * - it filters a rules file's closure ENTRY BY ENTRY on each file's own
 *   `paths:` — a path-scoped rule is dropped at launch while its unscoped
 *   imports load, and an unscoped rule's path-scoped import is dropped — but
 *   filters nothing under a `CLAUDE.md`;
 * - it reads `.claude/rules` in EVERY directory on the walk, not only the root;
 * - it skips any file over the size cliff, any file whose extension is not
 *   text, and any file with nothing left to inject once its frontmatter and
 *   comment blocks are gone, and follows none of their imports.
 *
 * So the walk is the authority on what loads at launch, and it runs over the
 * harness's own import edges — `harness_blob_imports`, through
 * {@link closureHopsFrom} (the closure primitive's resolver, asked one file at
 * a time) — which keeps "which `@` token is an import" a single question with a
 * single answer in this package: the shipped `Ayn`'s.
 *
 * The same walk answers what READING a file adds ({@link readWalk}, the
 * binary's `y3`): every rules directory on the chain, each closure filtered to
 * its path-scoped entries whose own `paths:` load the file.
 *
 * ## What it assumes
 *
 * External includes are APPROVED: an import that leaves the session's working
 * directory loads. The approval is per-user state the tree cannot show, and
 * assuming it is the over-report direction. `readdir` order is code-point
 * order per directory; the harness uses whatever the filesystem returns.
 *
 * @vendor-claim reviewed=2026-09-23 verify=Re-extract `$yn`, `$q`, `Lke`, `y3`, `dQe`, `q7e` and `Syn` from the current Claude Code binary per docs/external/claude-code-memory-loader.md and diff them against this walk and `harness/claude-code.ts`
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { BlobRow } from '../schemas/projection-blobs.js';
import type { HarnessBlobFactsRow } from '../schemas/projection-harness.js';
import type { ResourceRealizationRow, ResourceTagRow } from '../schemas/projection-resources.js';

import { RULES_FILE_TAG } from './agentic-tags.js';
import { ancestorDirectories, claudeAncestry } from './claude-context-ancestry.js';
import type { Admission } from './claude-context-query.js';
import { declaredPatterns, pathScopedMatch } from './claude-context-rules.js';
import { claudeImportExtentDeclaration } from './contributors/claude-import-extent.js';
import { closureHopsFrom } from './contributors/closure-extent.js';
import { CLAUDE_CODE, CLAUDE_IMPORT_MAX_DEPTH, CLAUDE_OVERSIZE_BYTES, isMemoryTextPath } from './harness/claude-code.js';
import { harnessFactsIndex, type HarnessFactsIndex } from './harness/facts-index.js';
import type { Projection } from './projection.js';
import { isAtOrBelow } from './root-relative-path.js';

/** One file the walk reached, and why. */
interface WalkEntry {
  readonly resourceId: string;
  readonly path: string;
  readonly admission: Admission;
}

/** What one launch walk produced. */
interface LaunchWalk {
  /**
   * Every file the launch reaches, in walk order — the files it LOADS, plus
   * any it reached and skipped at the size cliff, which the accounting labels.
   */
  readonly reached: readonly WalkEntry[];
  /**
   * Files reachable ONLY through a file the cliff skipped. The harness never
   * reads them; they are listed so the answer can say so.
   */
  readonly pruned: readonly WalkEntry[];
  /** Every walk root — each file the walk started a `$q` at — in walk order. */
  readonly roots: readonly string[];
}

/** The per-projection facts the walk reads, indexed once. */
interface WalkIndex {
  readonly projection: Projection;
  readonly fileByPath: ReadonlyMap<string, ResourceRealizationRow>;
  readonly blobByKey: ReadonlyMap<string, BlobRow>;
  readonly facts: HarnessFactsIndex;
  /** Every rules file, grouped under the directory holding its `.claude/rules`. */
  readonly rulesByHolder: ReadonlyMap<string, readonly string[]>;
  readonly hops: Map<string, readonly string[]>;
}

const walkIndexMemo = new WeakMap<Projection, WalkIndex>();

function walkIndexFor(projection: Projection): WalkIndex {
  const cached = walkIndexMemo.get(projection);
  if (cached !== undefined) return cached;
  const fileByPath = new Map<string, ResourceRealizationRow>();
  for (const row of projection.resourceRealizations) {
    if (!row.isDirectory && !fileByPath.has(row.path)) fileByPath.set(row.path, row);
  }
  const index: WalkIndex = {
    projection,
    fileByPath,
    blobByKey: new Map(projection.blobs.map((row) => [row.contentKey, row])),
    facts: harnessFactsIndex(projection, CLAUDE_CODE.id),
    rulesByHolder: rulesByHolder(fileByPath, projection.resourceTags),
    hops: new Map(),
  };
  walkIndexMemo.set(projection, index);
  return index;
}

/**
 * The directory holding a rules file's `.claude/rules`, or null when the path is not under one.
 *
 * @param path - A root-relative path
 * @returns The holder, `''` for the corpus root, or null
 */
export function rulesHolder(path: string): string | null {
  const forward = toForwardSlash(path);
  if (forward.startsWith('.claude/rules/')) return '';
  const at = forward.indexOf('/.claude/rules/');
  return at < 0 ? null : forward.slice(0, at);
}

/**
 * Every `rules-file`-tagged path, grouped by holder and in `Lke`'s order: a
 * directory's entries by name, a subdirectory's contents where its name falls.
 */
function rulesByHolder(
  fileByPath: ReadonlyMap<string, ResourceRealizationRow>,
  tags: readonly ResourceTagRow[],
): ReadonlyMap<string, readonly string[]> {
  const ruleIds = new Set(tags.filter((row) => row.tag === RULES_FILE_TAG).map((row) => row.resourceId));
  const grouped = new Map<string, string[]>();
  for (const [path, row] of fileByPath) {
    const holder = rulesHolder(path);
    if (holder === null || !ruleIds.has(row.resourceId)) continue;
    const rules = grouped.get(holder);
    if (rules === undefined) grouped.set(holder, [path]); else rules.push(path);
  }
  for (const rules of grouped.values()) rules.sort(bySegments);
  return grouped;
}

const LOWEST_CHARACTER = String.fromCodePoint(0);

/**
 * Segment-wise code-point order — a depth-first `readdir` over sorted names.
 * Ranking the separator below every other character orders whole paths the
 * way comparing them segment by segment would.
 */
function bySegments(left: string, right: string): number {
  const a = left.replaceAll('/', LOWEST_CHARACTER);
  const b = right.replaceAll('/', LOWEST_CHARACTER);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Why the harness does not load a file it reached, or undefined when it does:
 * no such file; an extension it does not read as text; past the size cliff; or
 * — `$q`'s `!he.content.trim()` — nothing left to inject once `q7e` has removed
 * the frontmatter and comment blocks. Only `oversize` is charged a row (the
 * accounting labels it); the other three load nothing and follow nothing.
 */
type Skip = 'absent' | 'not-text' | 'oversize' | 'injects-nothing';

function skipOf(index: WalkIndex, row: ResourceRealizationRow | undefined): Skip | undefined {
  if (row === undefined) return 'absent';
  if (!isMemoryTextPath(row.path)) return 'not-text';
  const blob = row.contentKey === null ? undefined : index.blobByKey.get(row.contentKey);
  // ⛔ The size cliff is NOT a reach rule. The loader still stats an oversize
  // file and `prunedBehind` follows its imports, so its harness facts must
  // exist: `hopsOf` reads them STRICTLY (a missing row throws), and when the
  // file becomes an answer row `rowsFor`'s `requireFacts` holds for the same
  // reason. Only the injected-bytes question is skipped here, not the facts.
  if (blob !== undefined && blob.bytes > CLAUDE_OVERSIZE_BYTES) return 'oversize';
  return factsOfReached(index, row)?.injectedBytes === 0 ? 'injects-nothing' : undefined;
}

/**
 * The harness facts of a file the walk reached, or undefined when it has no
 * blob to have facts OF (unkeyed, or a key with no `blobs` row — a question
 * about content, not facts, and answered as it always was).
 *
 * ⛔ A blob that exists and has no facts row THROWS (`HarnessFactsAbsentError`):
 * the walk reached it, so an absent row is a producer bug — reading it as
 * "injects nothing" or "scoped by nothing" would be a silent wrong answer.
 */
function factsOfReached(index: WalkIndex, row: ResourceRealizationRow): HarnessBlobFactsRow | undefined {
  if (row.contentKey === null || !index.blobByKey.has(row.contentKey)) return undefined;
  return index.facts.requireFacts(row.contentKey, row.path);
}

/**
 * A realization's `kyn` globs — `harness_blob_facts.paths`, the harness's own
 * read of ANY memory file's `paths:` — or null when it has none or no blob.
 * Never `blobs.frontmatter`: that is VAT's parser's answer, and a file routed
 * to no parser (an imported `.ts`) has none.
 */
function harnessPathsOf(index: WalkIndex, row: ResourceRealizationRow): HarnessBlobFactsRow['paths'] {
  return factsOfReached(index, row)?.paths ?? null;
}

/** Does this file declare `paths:` the harness keeps? `kyn`'s `globs`. */
function isScoped(index: WalkIndex, row: ResourceRealizationRow): boolean {
  return harnessPathsOf(index, row) !== null;
}

/** One file's import targets, through the closure primitive's own resolver. */
function hopsOf(index: WalkIndex, path: string): readonly string[] {
  const cached = index.hops.get(path);
  if (cached !== undefined) return cached;
  const root = index.projection.roots[0]?.path;
  if (root === undefined) {
    throw new Error('launchWalk received a projection with no root; import edges resolve against it.');
  }
  const hops = closureHopsFrom({
    root,
    resourceRealizations: index.projection.resourceRealizations,
    blobs: index.projection.blobs,
    blobReferences: index.projection.blobReferences,
    harnessBlobFacts: index.projection.harnessBlobFacts,
    harnessBlobImports: index.projection.harnessBlobImports,
    declaration: claudeImportExtentDeclaration(path),
  });
  index.hops.set(path, hops);
  return hops;
}

/** One `$q` call's state. */
interface Visit {
  readonly index: WalkIndex;
  readonly processed: Set<string>;
  /**
   * The directory an import (depth > 0) must stay inside, or null when
   * external includes are followed. The launch assumes approval (null); the
   * on-read walk never has it — `Abn`/`dQe` call `y3` with `includeExternal`
   * `!1`.
   */
  readonly within: string | null;
  readonly rootPath: string;
  readonly rootAdmission: Admission;
  readonly reached: WalkEntry[];
  readonly oversize: WalkEntry[];
}

/**
 * `$q` — one file and its import subtree, depth-first, pre-order.
 *
 * @returns The entries it loaded, each with whether it is path-scoped
 */
function visit(state: Visit, path: string, depth: number, viaPath: string | null): Array<WalkEntry & { scoped: boolean }> {
  if (state.processed.has(path) || depth > CLAUDE_IMPORT_MAX_DEPTH) return [];
  if (depth > 0 && state.within !== null && !isAtOrBelow(path, state.within)) return [];
  state.processed.add(path);
  const row = state.index.fileByPath.get(path);
  const skip = skipOf(state.index, row);
  if (row === undefined || (skip !== undefined && skip !== 'oversize')) return [];
  const admission: Admission = depth === 0
    ? state.rootAdmission
    : { kind: 'import', rootPath: state.rootPath, viaPath, depth };
  const entry = { resourceId: row.resourceId, path, admission };
  if (skip === 'oversize') {
    state.oversize.push(entry);
    return [{ ...entry, scoped: false }];
  }
  const loaded = [{ ...entry, scoped: isScoped(state.index, row) }];
  for (const target of hopsOf(state.index, path)) {
    loaded.push(...visit(state, target, depth + 1, path));
  }
  return loaded;
}

/**
 * What the harness loads for a session started in `directory`, in load order.
 *
 * @param projection - A populated projection
 * @param directory - The session's working directory, root-relative
 * @returns The walk
 */
export function launchWalk(projection: Projection, directory: string): LaunchWalk {
  const index = walkIndexFor(projection);
  const processed = new Set<string>();
  const reached: WalkEntry[] = [];
  const oversize: WalkEntry[] = [];
  const roots: string[] = [];
  const run = (path: string, admission: Admission, keep: (scoped: boolean) => boolean): void => {
    roots.push(path);
    const state: Visit = { index, processed, within: null, rootPath: path, rootAdmission: admission, reached, oversize };
    for (const entry of visit(state, path, 0, null)) {
      if (keep(entry.scoped)) reached.push({ resourceId: entry.resourceId, path: entry.path, admission: entry.admission });
    }
  };
  const chain = claudeAncestry(projection.resourceRealizations, projection.resourceTags, directory);
  for (const holder of ancestorDirectories(directory)) {
    const own = chain.filter((entry) => entry.holder === holder);
    // `local: entry.local` carries the slot the walk already knows onto the
    // admission itself — the ONE place that decides Project vs Local — rather
    // than leaving a later reader (the render header) to re-derive it from a
    // filename, which a rules file sharing the `CLAUDE.local.md` basename would
    // answer wrong (`claude-context-query.ts`'s `localAncestryRootPaths`).
    for (const entry of own.filter((candidate) => !candidate.local)) run(entry.path, { kind: 'ancestry', dir: entry.dir, local: entry.local }, keepAll);
    const ruleAdmission: Admission = holder === '' ? { kind: 'root-rule' } : { kind: 'nested-rule', under: holder };
    for (const rule of index.rulesByHolder.get(holder) ?? []) run(rule, ruleAdmission, keepUnscoped);
    for (const entry of own.filter((candidate) => candidate.local)) run(entry.path, { kind: 'ancestry', dir: entry.dir, local: entry.local }, keepAll);
  }
  return { reached, pruned: prunedBehind(index, oversize, processed), roots };
}

/**
 * What READING `file` adds, for a session started in the file's own directory:
 * the binary's `GUt` → `dQe` → `y3`, over every directory from the root down
 * to `directory` (`cwdLevelDirs`; with the session in the file's directory
 * there is no `nestedDirs` level between them).
 *
 * Each rules directory's closure is walked as the launch walks it, on ONE
 * visited set fresh for this read, and every PATH-SCOPED entry is kept iff its
 * OWN `paths:` loads `file` relative to the directory holding that
 * `.claude/rules` ({@link pathScopedMatch}) — a scoped rule, and equally a
 * file some rule imports that declares `paths:` of its own. Imports that leave
 * `directory` are not followed. What the launch already loaded is the
 * caller's to subtract (`sNe`).
 *
 * @param projection - A populated projection
 * @param directory - The session's working directory, root-relative
 * @param file - The file read, root-relative
 * @returns The path-scoped entries the read loads, in walk order; a rule
 *   itself carries its `glob-rule` admission, an import its `import` one
 */
export function readWalk(projection: Projection, directory: string, file: string): WalkEntry[] {
  const index = walkIndexFor(projection);
  const processed = new Set<string>();
  const loaded: WalkEntry[] = [];
  for (const holder of ancestorDirectories(directory)) {
    for (const rule of index.rulesByHolder.get(holder) ?? []) {
      const state: Visit = {
        index, processed, within: directory, rootPath: rule, rootAdmission: { kind: 'root-rule' }, reached: [], oversize: [],
      };
      for (const entry of visit(state, rule, 0, null)) {
        const kept = entry.scoped ? loadedOnRead(index, holder, entry, file) : undefined;
        if (kept !== undefined) loaded.push(kept);
      }
    }
  }
  return loaded;
}

/**
 * One path-scoped closure entry, kept when its OWN `paths:` — read under the
 * rules directory's `holder` — load `file`.
 *
 * @returns The entry with its on-read admission, or undefined when it does not load
 */
function loadedOnRead(index: WalkIndex, holder: string, entry: WalkEntry, file: string): WalkEntry | undefined {
  const row = index.fileByPath.get(entry.path);
  if (row === undefined) return undefined;
  const pattern = pathScopedMatch(holder, declaredPatterns(harnessPathsOf(index, row)), file);
  if (pattern === undefined) return undefined;
  const admission: Admission = entry.admission.kind === 'import' ? entry.admission : { kind: 'glob-rule', pattern };
  return { resourceId: entry.resourceId, path: entry.path, admission };
}

/** Nothing under a `CLAUDE.md`-family root is filtered. */
const keepAll = (): boolean => true;

/** A rules file's closure keeps, at launch, only the entries with no `paths:` of their own. */
const keepUnscoped = (scoped: boolean): boolean => !scoped;

/**
 * The files reachable only through a file the cliff skipped, attributed to it.
 *
 * Seeded with everything the launch VISITED — loaded or filtered — so a file
 * the walk reached by another route is never called pruned, and walked on a
 * private visited set so it cannot change what the launch loaded.
 */
function prunedBehind(index: WalkIndex, oversize: readonly WalkEntry[], visited: ReadonlySet<string>): WalkEntry[] {
  const pruned: WalkEntry[] = [];
  const seen = new Set(visited);
  for (const skipped of oversize) {
    const imported = skipped.admission.kind === 'import' ? skipped.admission : undefined;
    const rootPath = imported?.rootPath ?? skipped.path;
    const queue: Array<[string, number]> = [[skipped.path, imported?.depth ?? 0]];
    for (let hop = queue.shift(); hop !== undefined; hop = queue.shift()) {
      const [from, depth] = hop;
      if (depth >= CLAUDE_IMPORT_MAX_DEPTH) continue;
      for (const row of unseenTargets(index, from, seen)) {
        pruned.push({ resourceId: row.resourceId, path: row.path, admission: { kind: 'import', rootPath, viaPath: from, depth: depth + 1 } });
        queue.push([row.path, depth + 1]);
      }
    }
  }
  return pruned;
}

/**
 * The readable import targets of one file that nothing has seen yet, marked seen.
 *
 * @param index - The walk's index
 * @param from - The importing file
 * @param seen - Paths already seen, added to in place
 * @returns The targets' realizations
 */
function unseenTargets(index: WalkIndex, from: string, seen: Set<string>): ResourceRealizationRow[] {
  const rows: ResourceRealizationRow[] = [];
  for (const target of hopsOf(index, from)) {
    const row = index.fileByPath.get(target);
    if (seen.has(target) || row === undefined || skipOf(index, row) !== undefined) continue;
    seen.add(target);
    rows.push(row);
  }
  return rows;
}
