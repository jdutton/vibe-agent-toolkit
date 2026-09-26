/**
 * `whatLoadsAt(projection, path)` — the §6 query, and the only surface the CLI
 * imports.
 *
 * ## It is a function of the projection, and that is a testable claim
 *
 * Everything it reads is a materialised table, so a projection rehydrated from
 * the SQLite store answers identically to a freshly derived one. The unit suite
 * pins this by giving every fixture a corpus root that does not exist on disk: if
 * a resolution path ever starts stat-ing, the suite fails rather than the claim
 * quietly becoming false.
 *
 * ## Provenance is computed, not stored — and the reason is Ruling B's
 *
 * `resource_extents` is `{resourceId, extentId}` and nothing more. §6.2 needs
 * "which file pulled this in, at what depth", and the two ways to store it were
 * both refused: an `extent_edges` table contradicts `projection.ts:85-91`, which
 * places edges in the derived-per-lens column and is the exact position Ruling B
 * upheld when it declined to materialise `lens_entry_points`; and columns on
 * `resource_extents` cannot represent a diamond without widening a key five other
 * extent kinds depend on. So the launch walk (`claude-context-walk.ts`) asks the
 * closure primitive's own resolver for each file's edges — not a second
 * resolver — and records the importer and depth it reached each file at.
 *
 * ⭐ What loads, and when, is the WALK's answer, not the membership table's: the
 * harness walks depth-first with one visited set per launch and filters rules
 * closures entry by entry, which no union of per-root closures reproduces. A
 * member the membership table holds under a walked root but {@link closureProvenance}
 * cannot attribute is still listed in `unattributedImports`, as a disagreement
 * between two tables — never charged under a fabricated parent.
 *
 * ## Everything that does not vary with the queried path is derived ONCE
 *
 * ⚠️ Read the section above before reading this one: **nothing here is a stored
 * table**. {@link ContextQueryIndex} is an in-memory index this module derives
 * from a projection it already holds, and it computes exactly what the
 * per-query code computed — the same `closureProvenance` walk, the same
 * membership join, the same reference-shape read. What changes is the number of
 * times: once per projection instead of once per query. Ruling B's position is
 * about what the PROJECTION materialises, and this adds no row to it.
 *
 * The reason it matters is that the query is swept. `vat claude context --all`
 * answers every realized path, and every one of those answers used to rebuild
 * `pathOf`, `idOf`, `realizationOf`, the blob index, the reference-shape map and
 * every import closure's provenance — none of which depend on the path being
 * asked about. That made the per-answer cost proportional to the PROJECTION and
 * the sweep quadratic: measured at 11.4 ms per answer on a 2,195-blob tree and
 * 52 ms on an 8,768-blob one, a 4.6× rise for a 4.0× larger projection.
 *
 * What stays per-query is what genuinely varies: the launch walk
 * (`claude-context-walk.ts`, which memoizes its own per-projection index), the
 * rule selection ({@link selectRules}), which closures this query walked, and
 * the condition grading — whose escalation depends on `walkedExtents` and
 * therefore on the path.
 *
 * ### Why the memo is safe
 *
 * It is a `WeakMap` keyed on the projection's own object IDENTITY. A built
 * `Projection` is a bag of readonly arrays nothing mutates in place — every
 * variant in this repo's suites is built by spreading into a NEW object, which
 * gets a new index by construction. The index is a pure function of those
 * arrays, reads no ambient input (no clock, no environment, no filesystem — see
 * the fixture claim above), never crosses a process boundary, and is dropped
 * with the projection it hangs off. So there is nothing to invalidate and no
 * version to stamp: identity IS the key.
 *
 * ## Dedup is by `resourceId`, never by path and never over edges
 *
 * Two `CLAUDE.md` files importing one `README.md` load it once. The diamond is
 * what forces the key to be the identity: one target reached by two edges is one
 * row only if the sum is over identities rather than over edges. 🪤 **Not**
 * because `resourceId` collapses a symlink alias — it does not wherever git
 * answers, since `canonicalPathFor` returns git's spelling before it can reach
 * `realpathSync.native`; see *"🪤 A symlink and its target do NOT reliably share
 * one identity"* in `identity.ts`. One row per identity,
 * carrying every admission the ANSWER recorded — which for a diamond is one, not
 * two: the launch's visited set declines the second edge, so that edge is a hop
 * the walk refused rather than an admission the row is hiding.
 */

import { strongerSeverity, type Severity } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { estimateTokens } from '../link-classify.js';
import { ExtentDeclarationSchema } from '../schemas/project-config.js';
import type { BlobReferenceRow, BlobRow } from '../schemas/projection-blobs.js';
import type { ClaudeContextFinding } from '../schemas/projection-claude-context.js';
import type { HarnessBlobImportRow } from '../schemas/projection-harness.js';
import type {
  RealizationConditionRow,
  ResourceExtentRow,
  ResourceRealizationRow,
} from '../schemas/projection-resources.js';

import { CLAUDE_MD_TAG, classifyPath } from './agentic-tags.js';
import { ancestorDirectories } from './claude-context-ancestry.js';
import { selectRules, type RuleAdmission } from './claude-context-rules.js';
import { launchWalk, readWalk } from './claude-context-walk.js';
import {
  CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX,
} from './contributors/claude-import-extent.js';
import {
  closureProvenance,
  CLOSURE_DEPTH_EXCEEDED,
  CLOSURE_REFERENCE_OUTSIDE_ROOT,
  CLOSURE_ROOT_ABSENT,
  type ImportProvenance,
} from './contributors/closure-extent.js';
import { isDeclinedSymlinkCode } from './contributors/filesystem-extent.js';
import { CLAUDE_CODE } from './harness/claude-code.js';
import { harnessFactsIndex, type HarnessFactsIndex } from './harness/facts-index.js';
import type { LoadTrigger, MemoryKind } from './harness/profile.js';
import { REALIZATION_PATH_COLLISION, type Projection } from './projection.js';

/** Why one resource is in the answer. A row may carry several. */
export type Admission =
  | {
      readonly kind: 'ancestry';
      readonly dir: string;
      /**
       * Whether the walk loaded this through the `CLAUDE.local.md` slot rather
       * than the `CLAUDE.md`/`.claude/CLAUDE.md` slot — `claudeAncestry`'s own
       * `local` flag on the chain entry (`claude-context-ancestry.ts`), carried
       * here rather than re-derived from the FILENAME: a rules file (any
       * `.claude/rules/*.md`) is ALWAYS `Project` in the vendor's own model,
       * whatever it happens to be named, and only an `ancestry` admission can
       * ever be `local`.
       */
      readonly local: boolean;
    }
  | RuleAdmission
  | {
      readonly kind: 'import';
      readonly rootPath: string;
      readonly viaPath: string | null;
      readonly depth: number | null;
    };

/** Whether the harness loads this at launch or on demand. */
export type LoadClass = 'always' | 'on-demand';

/** One resource the query says is loaded, with its raw cost. */
export interface LoadedRow {
  readonly resourceId: string;
  readonly path: string;
  /**
   * `harness_blob_facts.injectedTokens` — the text the harness injects, not
   * the file — or null when this realization has no blob. A blob with no facts
   * row is never null here: it throws `HarnessFactsAbsentError`.
   */
  readonly tokens: number | null;
  /** `blobs.bytes`, or null when this realization has no blob. */
  readonly bytes: number | null;
  readonly loadClass: LoadClass;
  readonly admissions: readonly Admission[];
  /**
   * `CLAUDE_CODE.renderHeader`, estimated — the header line the harness prints
   * immediately before this file's content. Unlike {@link tokens}, never null:
   * it depends only on the absolute path, which loader branch loaded the file
   * (`Project`/`Local`) and whether it entered at launch or on a read, never on
   * measured content, so it is always known.
   */
  readonly headerTokens: number;
}

/**
 * A closure condition, graded for this report.
 *
 * `severity` carries `error` because the STORED severity is a floor this module
 * may raise and must never lower: `CLOSURE_ROOT_ABSENT` and
 * `REALIZATION_PATH_COLLISION` are both emitted at `error`, and a declared import
 * root the population never realized is a real misconfiguration — reporting it at
 * the same level as a `@jeff` mention would bury it. `strongerSeverity` from
 * `@vibe-agent-toolkit/schema` is what raises it, and it cannot lower.
 *
 * 🪤 This report used to spell the middle level `warn` while the stored
 * vocabulary spelled it `warning`, with a private translation function as "the
 * one place the two meet" — the seventh severity vocabulary in the tree. There
 * is one now, and it is the shared one.
 *
 * The shape itself is {@link ClaudeContextFindingSchema}'s
 * (`schemas/projection-claude-context.ts`) — `harness`, `why` and `affects`
 * added on top of what this report always carried, never a second shape a
 * caller has to reconcile against the schema's own.
 */
export type GradedCondition = ClaudeContextFinding;

/** The answer, when the queried path is one the projection realizes. */
export interface LoadedContextAnswer {
  readonly kind: 'answer';
  readonly input: string;
  readonly directory: string;
  /** The queried file, or null for a directory query — what makes globs exact. */
  readonly file: string | null;
  readonly rows: readonly LoadedRow[];
  readonly conditions: readonly GradedCondition[];
  readonly overBudgetRules: readonly string[];
  readonly unattributedImports: readonly string[];
}

/**
 * The query's result.
 *
 * ⛔ A path the projection never realized answers `unknown`, never `0`. A
 * confident zero is indistinguishable from a real empty answer, and the two are
 * the difference between "nothing loads here" and "VAT never looked".
 */
export type LoadedContext =
  | LoadedContextAnswer
  | { readonly kind: 'unknown'; readonly input: string; readonly reason: 'path-not-realized' };

/**
 * The one closure code this module ever escalates. `CLOSURE_REFERENCE_OUTSIDE_ROOT`
 * is never escalated — see {@link severityFor} — so it is not spelled as a second
 * constant here: a constant with no reader is exactly the kind of dead code the
 * zero-warnings lint gate refuses, and the reasoning is carried in prose instead,
 * at the one line that reasoning governs.
 */
const UNRESOLVED_CODE = 'CLOSURE_REFERENCE_UNRESOLVED';

/**
 * What loads at `inputPath`, and why.
 *
 * @param projection - A populated projection from `buildClaudeContextPopulation`
 * @param inputPath - Root-relative path, file or directory. `''` is the corpus root
 * @returns The answer, or a distinguishable `unknown`
 */
export function whatLoadsAt(projection: Projection, inputPath: string): LoadedContext {
  const index = contextQueryIndexFor(projection);
  const realization = index.realizationByPath.get(inputPath);
  if (inputPath !== '' && realization === undefined) {
    return { kind: 'unknown', input: inputPath, reason: 'path-not-realized' };
  }
  const isFile = realization !== undefined && !realization.isDirectory;
  const directory = isFile ? (realization?.dir ?? '') : inputPath;
  const file = isFile ? inputPath : null;

  const { admissions, classes, roots, overBudget } = loadedAt(projection, directory, file);
  // `importReport` (via `buildImportIndex`) throws when the projection carries
  // no root, so `rootPath` below is guaranteed present past this line — but it
  // is asserted explicitly rather than defaulted, the same way `hopsOf` does.
  const imports = importReport(index, roots);
  const rootPath = projection.roots[0]?.path;
  if (rootPath === undefined) {
    throw new Error('whatLoadsAt reached rowsFor with no root; the render header resolves an absolute path against it.');
  }

  return {
    kind: 'answer',
    input: inputPath,
    directory,
    file,
    rows: rowsFor(index, admissions, classes, rootPath),
    conditions: gradeConditions(projection, index, imports.walkedExtents, directory),
    overBudgetRules: overBudget,
    unattributedImports: imports.unattributed,
  };
}

/** The rule admissions that load a rule ON DEMAND — the `paths:` family. */
const ON_DEMAND_RULE_KINDS: ReadonlySet<Admission['kind']> = new Set([
  'glob-rule',
  'glob-rule-covers-dir',
  'glob-rule-may-fire',
]);

/**
 * Every admission this query records, each identity's load class, and the
 * import roots whose closures the answer reports on.
 *
 * ⭐ The LAUNCH half is {@link launchWalk} — the harness's own walk, replayed —
 * and nothing else decides it: a file is `always` exactly when that walk loads
 * it (or reaches it and skips it at the cliff, which the accounting labels).
 * The ON-DEMAND half, for a FILE query, is {@link readWalk} — what reading the
 * file adds: path-scoped rules AND path-scoped imports, each judged on its own
 * `paths:` — minus what the launch already loaded. For a DIRECTORY query no
 * file is read, so it is the ∀/∃ path-scoped rules the selection admits.
 *
 * `selectRules`' `root-rule` and `nested-rule` admissions are not read: an
 * unscoped rule in a directory on the walk is the walk's, and a second source
 * for it would be a second answer to one question.
 *
 * @param projection - The populated projection
 * @param directory - The query's directory — the session's working directory
 * @param file - The query's file, or null for a directory query
 * @returns Admissions and classes by `resourceId`, walked roots, over-budget rules
 */
function loadedAt(
  projection: Projection,
  directory: string,
  file: string | null,
): {
  admissions: Map<string, Admission[]>;
  classes: Map<string, LoadClass>;
  roots: ReadonlySet<string>;
  overBudget: readonly string[];
} {
  const admissions = new Map<string, Admission[]>();
  const classes = new Map<string, LoadClass>();
  const walk = launchWalk(projection, directory);
  for (const entry of walk.reached) {
    push(admissions, entry.resourceId, entry.admission);
    classes.set(entry.resourceId, 'always');
  }
  // A file only the cliff kept from the launch is listed under the route that
  // was cut, so the accounting can say why it costs nothing — and it takes
  // `always` from that route only when nothing else loads it on demand.
  const prunedOnly = new Set<string>();
  for (const entry of walk.pruned) {
    push(admissions, entry.resourceId, entry.admission);
    classes.set(entry.resourceId, 'always');
    prunedOnly.add(entry.resourceId);
  }

  const selection = selectRules({
    realizations: projection.resourceRealizations,
    tags: projection.resourceTags,
    facts: harnessFactsIndex(projection, CLAUDE_CODE.id),
    queryDir: directory,
    queryFile: file,
  });
  const roots = new Set(walk.roots);
  // A file query takes its on-demand set from the read walk, never from the
  // selection's file lane: the walk also reaches path-scoped IMPORTS, and it
  // spends a file once per read, as `y3` does. Both ask one matcher
  // (`pathScopedMatch`), so they cannot disagree about a rule.
  const onDemand = file === null
    ? selection.rules.filter((rule) => ON_DEMAND_RULE_KINDS.has(rule.admission.kind))
    : readWalk(projection, directory, file);
  for (const entry of onDemand) {
    push(admissions, entry.resourceId, entry.admission);
    if (entry.admission.kind !== 'import') roots.add(entry.path);
    if (!classes.has(entry.resourceId) || prunedOnly.has(entry.resourceId)) classes.set(entry.resourceId, 'on-demand');
  }
  return { admissions, classes, roots, overBudget: selection.overBudget };
}

/**
 * One member of a precomputed import closure, carrying the admission it earns.
 *
 * The admission object is shared by every answer that charges this closure,
 * which is sound because an {@link Admission} is deeply readonly and every
 * answer builds its OWN list around it ({@link push} allocates a fresh array per
 * query). Nothing an answer does can reach back into another's.
 */
interface ClosureMember {
  readonly resourceId: string;
  readonly path: string;
  readonly admission: Admission;
}

/** One `claude-import` closure, walked once per projection rather than per query. */
interface ImportClosure {
  /** The closure's `resolution_contexts.contextId`. */
  readonly extentId: string;
  /**
   * `resourceId` of the declared root, or undefined when nothing realizes it.
   *
   * Undefined is not an error here: a declaration naming an unrealized root
   * already has its `CLOSURE_ROOT_ABSENT` condition, and this closure is simply
   * one no query can ever admit.
   */
  readonly rootId: string | undefined;
  /** The declared root's root-relative path. */
  readonly rootPath: string;
  readonly members: readonly ClosureMember[];
}

/** Every import fact the query reads, derived once — see the module docstring. */
interface ImportIndex {
  /** In `zone_provenance` order, which is the order closures are charged in. */
  readonly closures: readonly ImportClosure[];
  /**
   * Context ids of EVERY claude-import extent, walked or not.
   *
   * Expressed as the whole set rather than as "the declined ones", because
   * declined-ness is per-query and this is not: {@link gradeConditions} tests
   * membership of this set against that query's `walkedExtents`.
   */
  readonly extentIds: ReadonlySet<string>;
}

/** The five realization-derived maps, all filled in ONE pass over the table. */
interface RealizationIndex {
  /** Path → its FIRST realization, replacing a linear `.find()` per query. */
  readonly realizationByPath: ReadonlyMap<string, ResourceRealizationRow>;
  /** `resourceId` → its FIRST realization — `rowsFor`'s `realizationOf`. */
  readonly firstRealizationById: ReadonlyMap<string, ResourceRealizationRow>;
  /** `resourceId` → path. ⚠️ LAST row wins, as `new Map(rows.map(…))` did. */
  readonly pathById: ReadonlyMap<string, string>;
  /** Path → `resourceId`. ⚠️ LAST row wins, for the same reason. */
  readonly idByPath: ReadonlyMap<string, string>;
  /** Path → `contentKey`, keyless rows omitted — `severityFor`'s `keyOf`. */
  readonly contentKeyByPath: ReadonlyMap<string, string>;
}

/**
 * Everything {@link whatLoadsAt} needs that does NOT vary with the queried path.
 *
 * @see The module docstring's *"Everything that does not vary with the queried
 *   path is derived ONCE"*, which carries the reasoning this interface only
 *   holds the shape of.
 */
interface ContextQueryIndex extends RealizationIndex {
  readonly blobByContentKey: ReadonlyMap<string, BlobRow>;
  /** Claude Code's facts per blob — absent is a thrown error, never zero. */
  readonly facts: HarnessFactsIndex;
  /** Reference key → whether the token is path-shaped — `severityFor`'s `shapeOf`. */
  readonly pathShapeByReference: ReadonlyMap<string, boolean>;
  /**
   * The import closures, walked on FIRST USE and never again.
   *
   * ⛔ A function rather than a field, and the laziness is behavioural, not an
   * optimisation. A projection with no root must throw when a closure is needed
   * and must still answer `unknown` for a path it never realized — which is what
   * it did when the root was read inside the closure pass. Building eagerly
   * would move that throw ahead of the `unknown` check and change the answer for
   * an unrealized path in a rootless projection.
   */
  readonly importClosures: () => ImportIndex;
}

/**
 * Per-projection memo of {@link ContextQueryIndex}, keyed on object identity.
 *
 * 🔑 No row-count guard and no version stamp, unlike `closure-extent.ts`'s memos
 * — and the asymmetry is the difference between the two inputs. Those key on a
 * `ProjectionBase`, whose arrays the merge driver appends to WHILE contributors
 * read it, so the count is the premise that keeps the cache honest. This one
 * keys on a built {@link Projection}, which is the driver's output and is never
 * appended to; a caller wanting a different projection builds a different object
 * and gets a different index. A count here would guard against nothing.
 */
const contextQueryIndexMemo = new WeakMap<Projection, ContextQueryIndex>();

/**
 * This projection's index, built at most once.
 *
 * @param projection - The populated projection
 * @returns The memoized index
 */
function contextQueryIndexFor(projection: Projection): ContextQueryIndex {
  const cached = contextQueryIndexMemo.get(projection);
  if (cached !== undefined) return cached;
  const built = buildContextQueryIndex(projection);
  contextQueryIndexMemo.set(projection, built);
  return built;
}

/**
 * Derive the whole index from a projection.
 *
 * @param projection - The populated projection
 * @returns The index, with its closure half still unbuilt
 */
function buildContextQueryIndex(projection: Projection): ContextQueryIndex {
  const realizations = indexRealizations(projection.resourceRealizations);
  let imports: ImportIndex | undefined;
  const facts = harnessFactsIndex(projection, CLAUDE_CODE.id);
  return {
    ...realizations,
    blobByContentKey: new Map(projection.blobs.map((row) => [row.contentKey, row])),
    facts,
    pathShapeByReference: indexReferenceShapes(projection.blobReferences, facts.imports()),
    importClosures: () => (imports ??= buildImportIndex(projection, realizations)),
  };
}

/**
 * The five realization-keyed maps, in one pass.
 *
 * ⚠️ The tie-breaks are NOT uniform, and each is the one the per-query code had.
 * `realizationByPath` and `firstRealizationById` keep the FIRST row, because
 * they replace a `.find()` and a `has`-guarded insert respectively;
 * `pathById`/`idByPath`/`contentKeyByPath` keep the LAST, because they replace
 * `new Map(rows.map(…))`, which overwrites. The two disagree only where one path
 * realizes two identities, which the `(extentId, path)` key makes rare and
 * `REALIZATION_PATH_COLLISION` makes visible — so this preserves the existing
 * behaviour rather than quietly picking one rule for all five.
 *
 * @param rows - `resource_realizations`, in projection order
 * @returns The five maps
 */
function indexRealizations(rows: readonly ResourceRealizationRow[]): RealizationIndex {
  const realizationByPath = new Map<string, ResourceRealizationRow>();
  const firstRealizationById = new Map<string, ResourceRealizationRow>();
  const pathById = new Map<string, string>();
  const idByPath = new Map<string, string>();
  const contentKeyByPath = new Map<string, string>();

  for (const row of rows) {
    if (!realizationByPath.has(row.path)) realizationByPath.set(row.path, row);
    if (!firstRealizationById.has(row.resourceId)) firstRealizationById.set(row.resourceId, row);
    pathById.set(row.resourceId, row.path);
    idByPath.set(row.path, row.resourceId);
    if (row.contentKey !== null) contentKeyByPath.set(row.path, row.contentKey);
  }

  return { realizationByPath, firstRealizationById, pathById, idByPath, contentKeyByPath };
}

/**
 * Reference key → whether the token is PATH-SHAPED, for {@link severityFor}.
 *
 * Both edge tables, because a condition's reference came from whichever one
 * its closure walks: `blob_references` under `href` (the lexer's own
 * `hasExtension`/`slashCount` columns, read rather than re-derived) and
 * `harness_blob_imports` under `claude-import` — the harness's OWN shape rule
 * (`CLAUDE_CODE.importShape`: a target naming a directory component is a
 * path, anything else is bare), not the lexer's extension test.
 *
 * @param references - `blob_references`, in projection order
 * @param imports - Claude Code's `harness_blob_imports`, in projection order
 * @returns The shape map, last row winning as the per-query build did
 */
function indexReferenceShapes(
  references: readonly BlobReferenceRow[],
  imports: readonly HarnessBlobImportRow[],
): ReadonlyMap<string, boolean> {
  const shapes = new Map<string, boolean>();
  for (const reference of references) {
    shapes.set(referenceKey(reference), reference.hasExtension || reference.slashCount > 0);
  }
  for (const entry of imports) {
    shapes.set(referenceKey(entry), CLAUDE_CODE.importShape(entry.target) === 'path');
  }
  return shapes;
}

/**
 * `resource_extents` grouped by extent, preserving each extent's row ORDER.
 *
 * That order is the answer's: {@link membersOf} used to scan the whole table per
 * closure and emit members in table order, so grouping has to keep it or the
 * `rows` array's admission lists would reorder — invisible to a type checker and
 * visible in every rendered report.
 *
 * @param memberships - `resource_extents`, in projection order
 * @returns `extentId` → its membership rows, in table order
 */
function membershipsByExtent(
  memberships: readonly ResourceExtentRow[],
): ReadonlyMap<string, readonly ResourceExtentRow[]> {
  const byExtent = new Map<string, ResourceExtentRow[]>();
  for (const row of memberships) {
    const rows = byExtent.get(row.extentId);
    if (rows === undefined) byExtent.set(row.extentId, [row]); else rows.push(row);
  }
  return byExtent;
}

/**
 * What the answer reports about the import closures rooted at the files this
 * query walked: which extents it walked, and which of their members
 * `closureProvenance` could not attribute to an importer.
 *
 * The closures no longer decide what loads — {@link launchWalk} does — but
 * their conditions still belong to the answer that walked their root, and a
 * member the membership table holds with no provenance is still a disagreement
 * between two tables the reader should see.
 *
 * @param index - The projection's index
 * @param roots - Root-relative paths of every file this query walked from
 * @returns The walked extents, and the unattributed members, deduplicated
 */
function importReport(
  index: ContextQueryIndex,
  roots: ReadonlySet<string>,
): { unattributed: string[]; walkedExtents: ReadonlySet<string> } {
  const unattributed = new Set<string>();
  const walkedExtents = new Set<string>();
  for (const closure of index.importClosures().closures) {
    if (!roots.has(closure.rootPath)) continue;
    walkedExtents.add(closure.extentId);
    for (const membership of closure.members) {
      if (membership.admission.kind === 'import' && membership.admission.depth === null) {
        unattributed.add(membership.path);
      }
    }
  }
  return { unattributed: [...unattributed], walkedExtents };
}

/**
 * Every `claude-import` closure in the projection, walked once.
 *
 * The declaration is read back off `zone_provenance.parameterSet` rather than
 * rebuilt, because that is what the population actually ran under: a rebuilt one
 * would silently disagree with a store-answered projection populated under a
 * different `referenceDialect`.
 *
 * ⚠️ Every closure is walked here, including ones no query will admit, where the
 * per-query code walked only the admitted ones. Over a sweep that is the whole
 * saving — each closure is walked once instead of once per query that charges it
 * — and for a single query it is bounded by the two `closure-extent.ts` memos:
 * the whole-projection indexes `closureProvenance` needs are built once for the
 * projection, so what each extra closure costs is its own traversal and nothing
 * proportional to the tree. `projection-claude-context-query-index.test.ts` pins
 * that with a forty-closure tree measured against a four-closure one.
 *
 * @param projection - The populated projection
 * @param realizations - The realization maps, for the root lookup and the join
 * @returns Every closure, in `zone_provenance` order, plus every import extent id
 * @throws When the projection carries no root. `merge.ts` is the only `addRoot`
 *   caller and adds exactly one, so this is an invariant rather than a reachable
 *   failure — and answering "zero import closures" instead would be a silent
 *   confident zero, indistinguishable from a tree that genuinely imports nothing.
 *   That is the one answer shape this query's `unknown` result exists to avoid
 */
function buildImportIndex(projection: Projection, realizations: RealizationIndex): ImportIndex {
  const root = projection.roots[0]?.path;
  if (root === undefined) {
    throw new Error(
      'whatLoadsAt received a projection with no root, which violates the projection invariant that'
      + ' every population has exactly one (`merge.ts` is the sole `addRoot` caller). Import closures'
      + ' resolve references against that root, so answering zero closures here would report "nothing'
      + ' is imported" for a tree nobody looked at.',
    );
  }
  const byExtent = membershipsByExtent(projection.resourceExtents);

  const closures: ImportClosure[] = [];
  const extentIds = new Set<string>();
  for (const provenanceRow of projection.zoneProvenance) {
    if (!provenanceRow.contributorId.startsWith(`${CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX}:`)) continue;
    extentIds.add(provenanceRow.contextId);
    const declaration = ExtentDeclarationSchema.parse(provenanceRow.parameterSet);
    const provenance = closureProvenance({
      root,
      resourceRealizations: projection.resourceRealizations,
      blobs: projection.blobs,
      blobReferences: projection.blobReferences,
      harnessBlobFacts: projection.harnessBlobFacts,
      harnessBlobImports: projection.harnessBlobImports,
      declaration,
    });
    closures.push({
      extentId: provenanceRow.contextId,
      rootId: realizations.idByPath.get(declaration.closureFrom),
      rootPath: declaration.closureFrom,
      members: membersOf(
        byExtent.get(provenanceRow.contextId) ?? [],
        declaration.closureFrom,
        provenance,
        realizations.pathById,
      ),
    });
  }
  return { closures, extentIds };
}

/**
 * One closure's members, each joined to its provenance.
 *
 * ⛔ Membership is the AUTHORITY and provenance is the LABEL. The walk is re-run
 * only to attribute rows that `resource_extents` already holds, so it can never
 * admit a member the contributor refused — and a member it fails to attribute is
 * reported as unattributed rather than given a plausible parent.
 *
 * The declared root is skipped: it is already in the answer as an ancestor or a
 * rule, and re-admitting it as an import of itself would be a second admission
 * for a hop that never happened.
 *
 * @param memberships - This extent's `resource_extents` rows, in table order —
 *   already grouped by {@link membershipsByExtent}, where the per-query code
 *   rescanned the whole table once per closure
 * @param rootPath - The closure's declared root
 * @param provenance - {@link closureProvenance}'s map for this closure
 * @param pathOf - `resourceId` → root-relative path
 * @returns Each member with its import admission
 */
function membersOf(
  memberships: readonly ResourceExtentRow[],
  rootPath: string,
  provenance: ReadonlyMap<string, ImportProvenance>,
  pathOf: ReadonlyMap<string, string>,
): ClosureMember[] {
  const members: ClosureMember[] = [];
  for (const membership of memberships) {
    const path = pathOf.get(membership.resourceId);
    if (path === undefined || path === rootPath) continue;
    const found = provenance.get(path);
    members.push({
      resourceId: membership.resourceId,
      path,
      admission: {
        kind: 'import' as const,
        rootPath,
        viaPath: found?.viaPath ?? null,
        depth: found?.depth ?? null,
      },
    });
  }
  return members;
}

/**
 * Turn the admission map into rows, one per identity.
 *
 * @param index - The projection's index
 * @param admissions - `resourceId` → every admission that reached it
 * @param classes - `resourceId` → its load class, decided by {@link loadedAt}
 * @param rootAbsolutePath - The corpus root's absolute path, for the header's
 *   absolute path
 * @returns One row per identity, path-ordered
 */
function rowsFor(
  index: ContextQueryIndex,
  admissions: ReadonlyMap<string, readonly Admission[]>,
  classes: ReadonlyMap<string, LoadClass>,
  rootAbsolutePath: string,
): LoadedRow[] {
  const localRoots = localAncestryRootPaths(index, admissions);
  const rows: LoadedRow[] = [];
  for (const [resourceId, list] of admissions) {
    const realization = index.firstRealizationById.get(resourceId);
    if (realization === undefined) continue;
    const blob = realization.contentKey === null
      ? undefined
      : index.blobByContentKey.get(realization.contentKey);
    const loadClass = classes.get(resourceId) ?? 'on-demand';
    rows.push({
      resourceId,
      path: realization.path,
      // `null` (unmeasured) only for a file with no blob. A keyed, walked blob
      // with no facts row throws — reading it as unmeasured would hide a bug.
      tokens: blob === undefined ? null : index.facts.requireFacts(blob.contentKey, realization.path).injectedTokens,
      bytes: blob?.bytes ?? null,
      loadClass,
      admissions: list,
      headerTokens: headerTokensFor(rootAbsolutePath, realization.path, list, loadClass, localRoots),
    });
  }
  return rows.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Root-relative paths of every identity the walk admitted through the `Local`
 * ancestry slot — `CLAUDE.local.md`, never `CLAUDE.md`/`.claude/CLAUDE.md`.
 *
 * ⛔ **Read off the `ancestry` admission's own {@link Admission.local} flag —
 * never re-derived from a filename.** A rules file (`.claude/rules/*.md`) is
 * `Project` in the vendor's own model however it happens to be NAMED — nothing
 * stops one being called `.claude/rules/CLAUDE.local.md`, and a basename test
 * would mislabel exactly that file `Local`. Only an `ancestry` admission can
 * ever be `local`, so scanning for that one kind is sound by construction: no
 * other admission kind carries the flag at all.
 *
 * @param index - The projection's index, for the identity → path lookup
 * @param admissions - `resourceId` → every admission that reached it
 * @returns Paths of every `Local`-slot ancestry root
 */
function localAncestryRootPaths(
  index: ContextQueryIndex,
  admissions: ReadonlyMap<string, readonly Admission[]>,
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const [resourceId, list] of admissions) {
    if (!list.some((admission) => admission.kind === 'ancestry' && admission.local)) continue;
    const path = index.firstRealizationById.get(resourceId)?.path;
    if (path !== undefined) paths.add(path);
  }
  return paths;
}

/**
 * The header {@link CLAUDE_CODE.renderHeader} renders before one row's
 * content, estimated.
 *
 * `kind` is `Local` iff the row's own CHAIN ROOT is one of {@link localRoots}
 * (an import inherits its importer's type, exactly as the harness's own `type`
 * parameter does, per `docs/external/claude-code-memory-loader.md`); everything
 * else `Project`. The chain root is the FIRST admission's `rootPath` for an
 * `import`, or the row's own path for every other admission kind — the row IS
 * its own chain root at depth 0 (an ancestry entry, a rules file, a rule's own
 * import root).
 *
 * ⚠️ **The first admission decides, not the "deciding" one `admissionLoadsAtLaunch`
 * names.** Every push into a row's admission list happens in walk order — the
 * launch walk's `reached`, then its `pruned`, then the on-demand pass — so the
 * first admission is the launch-side one whenever the row was ever reached at
 * launch, which is exactly the case `trigger` needs it to agree with. The one
 * state where the two CAN disagree is a file the cliff pruned at launch (never
 * rendered) that a later on-demand pass also reaches and reclassifies
 * `on-demand` — there `admissions[0]` is still the pruned launch admission
 * while `trigger` reads `read`, so `chainRoot`, and therefore `kind`, can be
 * stale for that row. It CAN be charged on-demand (a pruned launch attempt is
 * not evidence nothing ever reads the file). The disagreement stays
 * unobservable in the number this returns purely because `renderHeader` never
 * consults `kind` on a `read` trigger — the on-read attachment carries no
 * per-kind suffix at all (`docs/external/claude-code-memory-loader.md`'s
 * `nested_memory` branch) — so a wrong `kind` passed alongside `trigger:
 * 'read'` changes nothing about the returned estimate.
 *
 * `trigger` is `launch` exactly when `loadClass` is `always` — the harness's
 * kind suffix and joiner-free rendering apply to a launch entry and only to
 * one, and {@link LoadClass} is already the query's own answer to "does this
 * load at launch".
 *
 * @param rootAbsolutePath - The corpus root's absolute path
 * @param path - The row's own root-relative path
 * @param admissions - Every admission that reached this identity, in push order
 * @param loadClass - The row's decided load class
 * @param localRoots - Paths of every `Local`-slot ancestry root in this answer
 * @returns The header's estimated token count
 */
function headerTokensFor(
  rootAbsolutePath: string,
  path: string,
  admissions: readonly Admission[],
  loadClass: LoadClass,
  localRoots: ReadonlySet<string>,
): number {
  const deciding = admissions[0];
  const chainRoot = deciding?.kind === 'import' ? deciding.rootPath : path;
  const kind: MemoryKind = localRoots.has(chainRoot) ? 'Local' : 'Project';
  const trigger: LoadTrigger = loadClass === 'always' ? 'launch' : 'read';
  return estimateTokens(CLAUDE_CODE.renderHeader(safePath.join(rootAbsolutePath, path), kind, trigger));
}

/**
 * The closure conditions, graded for this report.
 *
 * §9.1 escalates an unresolved import to `warn` only when the token is
 * PATH-SHAPED — `hasExtension` or `slashCount > 0`, both already columns on
 * `blob_references` (`projection-blobs.ts:151,153`). So `@docs/missing.md` warns
 * and `@jeff` stays quiet, and the grading is a column read rather than a second
 * parse of a string the lexer already classified.
 *
 * ⛔ `CLOSURE_REFERENCE_OUTSIDE_ROOT` stays `info` unconditionally. The vendor
 * RECOMMENDS importing out of the tree — `@~/.claude/my-project-instructions.md`
 * is the documented way to share personal instructions across worktrees — and
 * whether such an import loaded is not knowable from the tree at all, because the
 * approval dialog may have been declined. The report never calls these
 * "external": external is defined against the WORKING DIRECTORY, which is not in
 * the tree, so `OUTSIDE_ROOT` and "external" are different sets.
 *
 * ⛔ Graded HERE and not in `ClosureExtentContributor`, which emits most
 * conditions at `info` and is shared with the skill lane: re-grading inside the
 * primitive would change that lane's output as a side effect.
 *
 * ⛔ SCOPED to the closures this query walked, for the same reason
 * {@link importClosuresFor} charges only those: `realization_conditions` is
 * tree-global, so an unresolved `@` inside a sibling directory's import closure
 * would otherwise be warned about in an answer that explicitly refused to charge
 * that closure. Conditions from any extent that is NOT an unwalked import extent
 * are kept — the base enumeration's own rows (`REALIZATION_PATH_COLLISION`)
 * belong to every answer.
 *
 * The declined set is expressed as *import extent AND not walked* rather than
 * materialised per query: the answer keeps every condition from every
 * non-closure extent, and only an import extent can be "some other directory's
 * session". {@link ImportIndex.extentIds} is the half that does not vary.
 *
 * A declined-link row (any of the three codes {@link isDeclinedSymlinkCode} accepts) is
 * base-extent and so tree-global too, and is scoped the same way — see
 * {@link linkBearsOn}. ⛔ Every declined-link code, never one: an out-of-root or
 * unresolved link is recorded under its own code and is exactly as absent from
 * the answer as any other.
 *
 * @param projection - The populated projection, for `realization_conditions`
 * @param index - The projection's index
 * @param walkedExtents - Context ids of the import closures this query charged
 * @param directory - The queried directory, root-relative, `''` for the root
 * @returns Every in-scope condition, with its report severity, its loader-rule
 *   explanation and — for a member of a walked import closure — the chain that
 *   reaches it
 */
function gradeConditions(
  projection: Projection,
  index: ContextQueryIndex,
  walkedExtents: ReadonlySet<string>,
  directory: string,
): GradedCondition[] {
  const closures = index.importClosures();
  const closuresByExtentId = new Map(closures.closures.map((closure) => [closure.extentId, closure]));
  const chain = new Set(ancestorDirectories(directory));

  return projection.realizationConditions
    .filter((row) => !closures.extentIds.has(row.extentId) || walkedExtents.has(row.extentId))
    .filter((row) => !isDeclinedSymlinkCode(row.code) || linkBearsOn(row.path, directory, chain))
    .map((row) => {
      const path = row.sourcePath ?? row.path;
      return {
        code: row.code,
        severity: strongerSeverity(
          row.severity,
          severityFor(row, index.pathShapeByReference, index.contentKeyByPath),
        ),
        harness: CLAUDE_CODE.id,
        path,
        subject: row.path === path ? null : row.path,
        line: row.sourceLine,
        ref: row.sourceRef,
        message: row.message,
        why: whyFor(row.code),
        affects: affectsFor(path, closuresByExtentId.get(row.extentId)),
      };
    });
}

/**
 * `why` for every code this report can explain in terms of a specific Claude
 * Code loader branch or a named VAT producer — see
 * `docs/external/claude-code-memory-loader.md` for the harness-loader entries.
 *
 * `CLOSURE_DEPTH_EXCEEDED` IS a harness loader branch — `oQe` refuses to
 * descend once depth reaches `Pyn` (5), so it gets a citation like the other
 * two, not {@link DEFAULT_WHY}. `REALIZATION_PATH_COLLISION` and
 * `CLOSURE_ROOT_ABSENT` are population-time facts with no harness branch to
 * cite at all, so they name their own VAT producer instead of a loader
 * function — {@link DEFAULT_WHY} would be honest for them too, but a fixed
 * producer is more useful than a generic fallback where one is known.
 *
 * Only an opaque refusal-cascade label (a caller-supplied string this module
 * cannot enumerate — and one the claude-import closures never declare, since
 * they carry no refusals) reaches {@link DEFAULT_WHY} today.
 */
const WHY_TEXTS: Readonly<Record<string, string>> = {
  [UNRESOLVED_CODE]:
    'Claude Code\'s import reader ($q, through Cge\'s "absent" branch) returns nothing for a target'
    + ' that resolves to no file: no error, no event — the import is silently skipped and nothing'
    + ' under this reference is ever injected.',
  [CLOSURE_REFERENCE_OUTSIDE_ROOT]:
    'Claude Code only follows an import past the population root when the target passes its own'
    + ' NO() containment check or the session\'s external includes are approved'
    + ' (hasClaudeMdExternalIncludesApproved) — a per-user decision this tree cannot show, so'
    + ' whether this loads depends on that approval, not on anything the tree states.',
  [CLOSURE_DEPTH_EXCEEDED]:
    'Claude Code\'s import walk (`oQe`) refuses to descend once depth reaches `Pyn` (5): the root'
    + ' is depth 0 and four hops load, so a target reachable only at the fifth hop or deeper is'
    + ' never followed, however real the file is.',
  [REALIZATION_PATH_COLLISION]:
    'Not a Claude Code loader branch: VAT\'s own ProjectionBuilder enforces one realization per'
    + ' (extent, path), so a second identity claiming a path already taken is recorded here rather'
    + ' than silently overwriting the first.',
  [CLOSURE_ROOT_ABSENT]:
    'Not a Claude Code loader branch: the closure primitive\'s own check that a declared'
    + ' `closureFrom` realizes somewhere in this projection — nothing the harness itself decides.',
};

/**
 * `why` for a `realization_conditions` code {@link WHY_TEXTS} does not name —
 * today, only an opaque refusal-cascade label. Honest rather than a fabricated
 * loader citation: it names what it IS (a VAT-produced fact) without claiming
 * which harness branch produced it, matching this module's own `why` field
 * description on {@link ClaudeContextFindingSchema}.
 */
const DEFAULT_WHY = 'Not a Claude Code loader branch: a VAT-produced fact — see `message` for what was'
  + ' observed and `code` for which check raised it.';

/**
 * @param code - `realization_conditions.code`
 * @returns The loader-rule (or named-producer) explanation for this code
 */
function whyFor(code: string): string {
  return WHY_TEXTS[code] ?? DEFAULT_WHY;
}

/**
 * The import chain from a walked closure's entry point to `path`, when `path`
 * belongs to one.
 *
 * @param path - The finding's own location — {@link gradeConditions}' `path`
 * @param closure - The closure `path`'s condition was filed under, or
 *   undefined when it was not an import closure at all (a base-extent
 *   condition)
 * @returns `affects`, or null when `path` names no walked import closure —
 *   including a base-extent condition and a closure member
 *   {@link closureProvenance} could not attribute
 */
function affectsFor(path: string, closure: ImportClosure | undefined): GradedCondition['affects'] {
  if (closure === undefined) return null;
  const chain = chainTo(path, closure);
  return chain === null ? null : { chain, hop: chain.length - 1 };
}

/**
 * `path`'s import chain within `closure`, root-down — walked by following each
 * member's `viaPath` BACKWARD from `path` to `closure.rootPath`, using the same
 * per-member provenance {@link membersOf} already attached. Not a second
 * `closureProvenance` call: the members list already carries what that walk
 * found.
 *
 * @param path - The path to trace back to the closure's root
 * @param closure - The closure to trace it within
 * @returns The chain root-first ending at `path`, or null when `path` is not
 *   `closure.rootPath` and cannot be traced all the way back to it — an
 *   unattributed member (`viaPath: null` at a nonzero depth) breaks the trace,
 *   and reporting a guessed parent there would launder a "cannot say" into a fact
 */
function chainTo(path: string, closure: ImportClosure): string[] | null {
  if (path === closure.rootPath) return [closure.rootPath];
  const admissionByPath = new Map(closure.members.map((member) => [member.path, member.admission]));
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = path;
  while (current !== closure.rootPath) {
    if (visited.has(current)) return null;
    visited.add(current);
    chain.unshift(current);
    const admission = admissionByPath.get(current);
    if (admission?.kind !== 'import' || admission.viaPath === null) return null;
    current = admission.viaPath;
  }
  chain.unshift(closure.rootPath);
  return chain;
}

/**
 * Whether a declined link at `linkPath` could hide something a session started
 * in `directory` loads — the only links its answer names.
 *
 * Without this every answer carried every link in the tree: one
 * `CLAUDE.md -> AGENTS.md` in a sibling directory was ~400 characters of noise
 * in every directory's answer. A link bears on the query when it is
 *
 * - beneath the queried directory — it may BE, or hide, an on-demand file;
 * - a `CLAUDE.md`-family name in a directory on the chain — a launch-time file; or
 * - at or under ANY `.claude/rules` — a path-scoped rule is selected by glob
 *   tree-wide, and a nested one is tried root-relative too (`matchingForms`),
 *   so it can load for a directory outside its own; or
 * - at or under a `.claude` directory on the chain — the root's
 *   `.claude/CLAUDE.md`, a nested `.claude` a session there reads.
 *
 * Both decided by path SEGMENT, never by extension: the vendor's shared-rules
 * pattern links a whole DIRECTORY, `.claude/rules/shared -> ~/shared-claude-rules`.
 *
 * The `CLAUDE.md` family is classified by its PATH through the shipped
 * classifier, as a realization would be: a link has no tags because it has no
 * realization. The empty plugin-root set is exact here, not a default — the
 * convention asked about does not consult it.
 *
 * @param linkPath - Root-relative link path
 * @param directory - The queried directory, `''` for the root
 * @param chain - `ancestorDirectories(directory)`
 * @returns True when the answer should carry the link's row
 */
function linkBearsOn(linkPath: string, directory: string, chain: ReadonlySet<string>): boolean {
  const slash = linkPath.lastIndexOf('/');
  const parent = slash === -1 ? '' : linkPath.slice(0, slash);
  // Beneath the queried directory: it is one of the link's own ancestors.
  if (ancestorDirectories(parent).includes(directory)) return true;
  if (DOT_CLAUDE_RULES_SEGMENT.test(linkPath)) return true;
  for (const match of linkPath.matchAll(DOT_CLAUDE_SEGMENT)) {
    // The directory holding this `.claude` — `''` at the root.
    if (chain.has(linkPath.slice(0, Math.max(match.index, 0)))) return true;
  }
  const tags = classifyPath(linkPath, linkPath.slice(slash + 1).toLowerCase(), new Set());
  return tags.some((row) => row.tag === CLAUDE_MD_TAG) && chain.has(parent);
}

/** A `.claude` path segment; `index` is where the holding directory's spelling ends. */
const DOT_CLAUDE_SEGMENT = /(?:^|\/)\.claude(?=\/|$)/g;

/** A `.claude/rules` directory, or anything beneath one, at any depth. No `g`: `test` stays stateless. */
const DOT_CLAUDE_RULES_SEGMENT = /(?:^|\/)\.claude\/rules(?:\/|$)/;

/**
 * The escalation this report applies to one condition, before its stored
 * severity is taken into account — `strongerSeverity` takes the max of the two,
 * which is what keeps this from ever LOWERING a row.
 *
 * ⛔ The stored severity is a floor: `CLOSURE_ROOT_ABSENT` and
 * `REALIZATION_PATH_COLLISION` are emitted at `error`, and re-deriving a
 * severity from the code alone once silently demoted both to `info` — a declared
 * import root the population never realized reported as quietly as a `@jeff`
 * mention. Escalation stays the report's job; demotion is never anybody's.
 *
 * @param row - The stored condition
 * @param shapeOf - Reference key → whether the token is path-shaped
 * @param keyOf - Root-relative path → its `contentKey`
 * @returns `warning` for a path-shaped in-root unresolved import, else `info`
 */
function severityFor(
  row: RealizationConditionRow,
  shapeOf: ReadonlyMap<string, boolean>,
  keyOf: ReadonlyMap<string, string>,
): Severity {
  // ⛔ ONLY the unresolved code is ever escalated, which is what keeps
  // CLOSURE_REFERENCE_OUTSIDE_ROOT at `info` by construction rather than by a
  // second condition someone could later delete as redundant. §9.2 is emphatic
  // that an escaping import is HEALTHY: the vendor recommends it.
  if (row.code !== UNRESOLVED_CODE) return 'info';
  if (row.sourcePath === null || row.sourceLine === null || row.sourceRef === null) return 'info';
  const contentKey = keyOf.get(row.sourcePath);
  if (contentKey === undefined) return 'info';
  // A condition whose reference row cannot be found stays `info` rather than
  // being re-derived from the string: the columns are the fact, and a second
  // parse would be a heuristic wearing a column's authority.
  return shapeOf.get(joinKey(contentKey, row.sourceLine, row.sourceRef)) === true
    ? 'warning'
    : 'info';
}

/**
 * The join key between a condition's three provenance columns and its reference.
 *
 * ⚠️ The blob foreign key on `blob_references` is named **`blob`**, NOT
 * `contentKey` (`projection-blobs.ts:246`). The condition side reaches the same
 * value through `sourcePath` → that realization's `contentKey`, so the two
 * spellings meet here — which is exactly why the key is built by ONE function
 * both sides call rather than by two template literals free to disagree.
 *
 * @param reference - One `blob_references` row
 * @returns The composite key
 */
function referenceKey(reference: Pick<BlobReferenceRow, 'blob' | 'line' | 'rawRef'>): string {
  return joinKey(reference.blob, reference.line, reference.rawRef);
}

/**
 * The composite key's one spelling.
 *
 * A single space separator, and deliberately no NUL byte. `rawRef` is arbitrary
 * author text and could contain a space — but the first two components are
 * fixed-shape (a content hash, then a decimal line number), so the split point
 * is never ambiguous whatever follows it. A NUL would be marginally more
 * defensive and makes every tool that touches the file treat it as binary.
 *
 * @param blob - The referring blob's content key
 * @param line - The reference's 1-based line
 * @param rawRef - The reference exactly as authored
 * @returns The composite key
 */
function joinKey(blob: string, line: number, rawRef: string): string {
  return [blob, String(line), rawRef].join(' ');
}

/**
 * Append one admission under an identity.
 *
 * @param map - The admission map, mutated in place
 * @param resourceId - The identity admitted
 * @param admission - Why it was admitted
 */
function push(map: Map<string, Admission[]>, resourceId: string, admission: Admission): void {
  const list = map.get(resourceId);
  if (list === undefined) map.set(resourceId, [admission]); else list.push(admission);
}

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare`, which sonarjs suggests by default:
 * it is ICU- and locale-dependent, so two machines could order this answer's
 * rows differently — and this array's order IS the answer's order.
 * `claude-context-ancestry.ts`'s `comparePaths` and `claude-import-extent.ts`'s
 * `byCodePoint` refuse it on the same ground; this is the third copy of the
 * same three-line idiom rather than an import, because none of the three
 * modules exports it and inventing a shared export for a three-line comparator
 * used by two files is not what "add utilities only when needed" calls for.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
