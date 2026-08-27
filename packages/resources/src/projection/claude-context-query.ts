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
 * extent kinds depend on. So {@link closureProvenance} re-runs the SAME traversal
 * the contributor ran — not a second resolver, the same `traverseClosure` — and
 * this module joins the result onto membership.
 *
 * A member the map cannot attribute renders `viaPath: null, depth: null` and is
 * listed in `unattributedImports`. Never a fabricated parent.
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
 * What stays per-query is what genuinely varies: the ancestry chain
 * ({@link claudeAncestry}), the rule selection ({@link selectRules}), which
 * closures this query's admissions charge, and the condition grading — whose
 * escalation depends on `walkedExtents` and therefore on the path.
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
 * two: the closure's visited set declines the second edge, so that edge is a hop
 * the traversal refused rather than an admission the row is hiding.
 */

import { ExtentDeclarationSchema } from '../schemas/project-config.js';
import type { BlobReferenceRow, BlobRow } from '../schemas/projection-blobs.js';
import type {
  RealizationConditionRow,
  ResourceExtentRow,
  ResourceRealizationRow,
} from '../schemas/projection-resources.js';
import type { ProjectionConditionSeverity } from '../schemas/projection-shared.js';

import { claudeAncestry } from './claude-context-ancestry.js';
import { selectRules, type RuleAdmission } from './claude-context-rules.js';
import {
  CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX,
} from './contributors/claude-import-extent.js';
import {
  closureProvenance,
  type ImportProvenance,
} from './contributors/closure-extent.js';
import type { Projection } from './projection.js';

/** Why one resource is in the answer. A row may carry several. */
export type Admission =
  | { readonly kind: 'ancestry'; readonly dir: string }
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
  /** `blobs.tokenEstimate`, or null when this realization has no blob — never 0. */
  readonly tokens: number | null;
  /** `blobs.bytes`, or null when this realization has no blob. */
  readonly bytes: number | null;
  readonly loadClass: LoadClass;
  readonly admissions: readonly Admission[];
}

/**
 * A closure condition, graded for this report.
 *
 * `severity` carries `error` because the STORED severity is a floor this module
 * may raise and must never lower: `CLOSURE_ROOT_ABSENT` and
 * `REALIZATION_PATH_COLLISION` are both emitted at `error`, and a declared import
 * root the population never realized is a real misconfiguration — reporting it at
 * the same level as a `@jeff` mention would bury it. The stored vocabulary spells
 * the middle level `warning` (`ProjectionConditionSeveritySchema`); this report
 * spells it `warn`, and {@link strongerSeverity} is the one place the two meet.
 */
export interface GradedCondition {
  readonly code: string;
  readonly severity: 'info' | 'warn' | 'error';
  readonly path: string;
  readonly sourcePath: string | null;
  readonly sourceLine: number | null;
  readonly sourceRef: string | null;
  readonly message: string;
}

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

  const { admissions, overBudget } = baseAdmissions(projection, directory, file);

  // Snapshotted BEFORE the import pass, because that pass adds to `admissions`:
  // only closures rooted at something the ANCESTRY and RULE passes admitted are
  // relevant, and letting an import's own members seed further roots would walk
  // the whole tree's instruction graph rather than this directory's.
  const admittedIds = new Set(admissions.keys());
  const imports = applyImportClosures(index, admittedIds, admissions);

  return {
    kind: 'answer',
    input: inputPath,
    directory,
    file,
    rows: rowsFor(index, admissions),
    conditions: gradeConditions(projection, index, imports.walkedExtents),
    overBudgetRules: overBudget,
    unattributedImports: imports.unattributed,
  };
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
  return {
    ...realizations,
    blobByContentKey: new Map(projection.blobs.map((row) => [row.contentKey, row])),
    pathShapeByReference: indexReferenceShapes(projection.blobReferences),
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
 * A column read, never a second parse of the token — see {@link gradeConditions}.
 *
 * @param references - `blob_references`, in projection order
 * @returns The shape map, last row winning as the per-query build did
 */
function indexReferenceShapes(
  references: readonly BlobReferenceRow[],
): ReadonlyMap<string, boolean> {
  const shapes = new Map<string, boolean>();
  for (const reference of references) {
    shapes.set(referenceKey(reference), reference.hasExtension || reference.slashCount > 0);
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
 * The ancestry and rule-scope admissions for one query — the two passes that
 * decide which `CLAUDE.md`/`CLAUDE.local.md` files and `.claude/rules` files
 * this query loads BEFORE any import is followed.
 *
 * Split out of {@link whatLoadsAt} to stay under the cognitive-complexity
 * ceiling: the two `for` loops here plus the import-closure loop together
 * exceed it in one body, and this is the half the brief names to extract.
 * {@link applyImportClosures} is the other half, and the two stay separate
 * because the set of already-admitted ids has to be snapshotted between them —
 * see the call site.
 *
 * @param projection - The populated projection
 * @param directory - The query's directory
 * @param file - The query's file, or null for a directory query
 * @returns Every ancestry/rule admission, keyed by `resourceId`, plus the
 *   rule-scope pass's over-budget report
 */
function baseAdmissions(
  projection: Projection,
  directory: string,
  file: string | null,
): { admissions: Map<string, Admission[]>; overBudget: readonly string[] } {
  const admissions = new Map<string, Admission[]>();
  for (const entry of claudeAncestry(projection.resourceRealizations, projection.resourceTags, directory)) {
    push(admissions, entry.resourceId, { kind: 'ancestry', dir: entry.dir });
  }

  const selection = selectRules({
    realizations: projection.resourceRealizations,
    tags: projection.resourceTags,
    blobs: projection.blobs,
    queryDir: directory,
    queryFile: file,
  });
  // Both primitives dedupe by identity internally — `claudeAncestry` over its
  // chain, `selectRules` over `resource_realizations`' `(extentId, path)` rows —
  // so this seam adds no guard of its own. A second guard here would be a
  // doubled mechanism: it would keep passing after the source one broke, and it
  // could only ever mask the `overBudget` half `selectRules` also emits.
  for (const rule of selection.rules) {
    push(admissions, rule.resourceId, rule.admission);
  }

  return { admissions, overBudget: selection.overBudget };
}

/**
 * Fold every relevant import closure's members into `admissions`.
 *
 * Only the closures this query ADMITTED are charged: an import extent rooted at
 * a `CLAUDE.md` the query never reached is an extent for some other directory's
 * session, and charging it here is exactly the tree-global over-report
 * `rule-scope` exists to prevent. That filter is per-query; the closures
 * themselves are not, and live in {@link ImportIndex}.
 *
 * @param index - The projection's index
 * @param admittedIds - Resource ids the ancestry and rule passes already admitted
 * @param admissions - The admission map, mutated in place
 * @returns The root-relative path of every import member `closureProvenance`
 *   could not attribute a parent to — deduplicated, because one path may be an
 *   unattributable member of two different closures and the field is a SET of
 *   paths the answer cannot explain, not a tally of how often it failed — plus
 *   the extents actually walked, which is what scopes {@link gradeConditions}
 */
function applyImportClosures(
  index: ContextQueryIndex,
  admittedIds: ReadonlySet<string>,
  admissions: Map<string, Admission[]>,
): { unattributed: string[]; walkedExtents: ReadonlySet<string> } {
  const unattributed = new Set<string>();
  const walkedExtents = new Set<string>();
  for (const closure of index.importClosures().closures) {
    if (closure.rootId === undefined || !admittedIds.has(closure.rootId)) continue;
    walkedExtents.add(closure.extentId);
    for (const membership of closure.members) {
      push(admissions, membership.resourceId, membership.admission);
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
      blobReferences: projection.blobReferences,
      declaration,
    });
    closures.push({
      extentId: provenanceRow.contextId,
      rootId: realizations.idByPath.get(declaration.closureFrom),
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
 * @returns One row per identity, path-ordered
 */
function rowsFor(
  index: ContextQueryIndex,
  admissions: ReadonlyMap<string, readonly Admission[]>,
): LoadedRow[] {
  const classes = loadClasses(admissions, index.idByPath);

  const rows: LoadedRow[] = [];
  for (const [resourceId, list] of admissions) {
    const realization = index.firstRealizationById.get(resourceId);
    if (realization === undefined) continue;
    const blob = realization.contentKey === null
      ? undefined
      : index.blobByContentKey.get(realization.contentKey);
    rows.push({
      resourceId,
      path: realization.path,
      tokens: blob?.tokenEstimate ?? null,
      bytes: blob?.bytes ?? null,
      loadClass: classes.get(resourceId) ?? 'on-demand',
      admissions: list,
    });
  }
  return rows.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Every admitted identity's load class, resolved together.
 *
 * ⛔ An `import` admission is NOT launch-time on its own. The harness loads a
 * closure's members when it loads the closure's ROOT, so a `@`-import out of a
 * nested `.claude/rules` file — a file the session loads on demand — pulls its
 * targets in on demand too. Reading the admission alone said `always`, which
 * over-reported the launch-time budget for every adopter whose nested rules
 * import shared docs. So the class of an import member is the class of its
 * closure root, and this is resolved as a set rather than per row.
 *
 * The propagation is a least fixpoint over a two-element lattice, and the rule
 * at a join is **`always` wins**: a member reachable from an `always` root and
 * an `on-demand` root IS loaded at launch by the first, and under-reporting is
 * the one direction a context-budget answer cannot tolerate. Because `always`
 * only ever spreads, the fixpoint is unique and independent of iteration order.
 *
 * The loop is needed rather than a single lookup because a closure root can be
 * `always` only by import: a nested rules file at the fourth hop of a
 * `CLAUDE.md`'s closure is launch-time by that import, its own closure carries
 * the fifth hop the outer one refused (`maxDepth: 4`), and that member must
 * inherit the same class.
 *
 * @param admissions - `resourceId` → every admission that reached it
 * @param idOf - Root-relative path → `resourceId`, for resolving closure roots
 * @returns Each admitted identity's load class
 */
function loadClasses(
  admissions: ReadonlyMap<string, readonly Admission[]>,
  idOf: ReadonlyMap<string, string>,
): Map<string, LoadClass> {
  const classes = new Map<string, LoadClass>();
  for (const [resourceId, list] of admissions) classes.set(resourceId, baseLoadClass(list));

  let changed = true;
  while (changed) {
    changed = false;
    for (const [resourceId, list] of admissions) {
      if (classes.get(resourceId) === 'always') continue;
      if (!importsFromAlwaysRoot(list, classes, idOf)) continue;
      classes.set(resourceId, 'always');
      changed = true;
    }
  }
  return classes;
}

/**
 * The load class an identity earns from its OWN admissions, ignoring imports.
 *
 * `always` wins among these too: a file that is both an ancestor and a nested
 * rule is loaded at launch either way.
 *
 * ⛔ A `glob-rule` is NOT in this set, and the omission is the whole point. The
 * vendor puts *"rules that load on demand, including path-scoped rules and rules
 * in nested `.claude/rules/` directories"* in ONE class, and an earlier draft
 * acted on the second half of that sentence while carrying the first half
 * through unchanged. Matching a `paths:` glob decides WHETHER the rule is in
 * this query's answer at all; it does not promote it to launch time. The tell is
 * that it cannot: the same file is `glob-rule` for a FILE query and
 * `glob-rule-may-fire` for the DIRECTORY above it, so classing the first
 * `always` would make more precision about the query change when the harness
 * loads the file — a contradiction, not a refinement. `root-rule` stays because
 * an unscoped root rule genuinely does load at launch.
 *
 * ⛔ `glob-rule-covers-dir` is NOT in this set either, and it is the one that
 * looks like it should be. A ∀ rule matches every file under the query directory,
 * so it reads as a second `CLAUDE.md` for that directory — but a directory-scoped
 * `CLAUDE.md` loads when the SESSION starts and a path-scoped rule loads when the
 * agent touches a matching file, and those are different moments. The same
 * contradiction as above settles it: that rule is `glob-rule` for a file query
 * one level down, so classing the ∀ form `always` would make the launch-time
 * budget depend on how precisely the question was asked. ∀ is the BURDEN signal
 * the `on-demand` total earns from naming the pattern, never a load class.
 *
 * @param admissions - Every admission that reached one identity
 * @returns `always` when a non-import admission loads at launch, else `on-demand`
 */
function baseLoadClass(admissions: readonly Admission[]): LoadClass {
  const always = admissions.some(
    (admission) => admission.kind === 'ancestry' || admission.kind === 'root-rule',
  );
  return always ? 'always' : 'on-demand';
}

/**
 * Does any of this identity's import admissions name a launch-time closure root?
 *
 * @param admissions - Every admission that reached one identity
 * @param classes - The classes resolved so far, mid-fixpoint
 * @param idOf - Root-relative path → `resourceId`
 * @returns True when at least one closure root is currently classed `always`
 */
function importsFromAlwaysRoot(
  admissions: readonly Admission[],
  classes: ReadonlyMap<string, LoadClass>,
  idOf: ReadonlyMap<string, string>,
): boolean {
  return admissions.some((admission) => {
    if (admission.kind !== 'import') return false;
    const rootId = idOf.get(admission.rootPath);
    return rootId !== undefined && classes.get(rootId) === 'always';
  });
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
 * @param projection - The populated projection, for `realization_conditions`
 * @param index - The projection's index
 * @param walkedExtents - Context ids of the import closures this query charged
 * @returns Every in-scope condition, with its report severity
 */
function gradeConditions(
  projection: Projection,
  index: ContextQueryIndex,
  walkedExtents: ReadonlySet<string>,
): GradedCondition[] {
  const importExtentIds = index.importClosures().extentIds;

  return projection.realizationConditions
    .filter((row) => !importExtentIds.has(row.extentId) || walkedExtents.has(row.extentId))
    .map((row) => ({
      code: row.code,
      severity: strongerSeverity(
        row.severity,
        severityFor(row, index.pathShapeByReference, index.contentKeyByPath),
      ),
      path: row.path,
      sourcePath: row.sourcePath,
      sourceLine: row.sourceLine,
      sourceRef: row.sourceRef,
      message: row.message,
    }));
}

/**
 * The stronger of a condition's STORED severity and this report's escalation.
 *
 * ⛔ Grades UPWARD only. The stored severity is a floor: `CLOSURE_ROOT_ABSENT`
 * and `REALIZATION_PATH_COLLISION` are emitted at `error`, and re-deriving a
 * severity from the code alone silently demoted both to `info` — a declared
 * import root the population never realized reported as quietly as a `@jeff`
 * mention. Escalation stays the report's job; demotion is never anybody's.
 *
 * The two vocabularies differ by one spelling — the stored enum says `warning`,
 * the report says `warn` — and this is the single place they are translated.
 *
 * @param stored - `realization_conditions.severity`, as the producer emitted it
 * @param escalated - What {@link severityFor} would raise this row to
 * @returns The stronger of the two, in the report's vocabulary
 */
function strongerSeverity(
  stored: ProjectionConditionSeverity,
  escalated: 'info' | 'warn',
): GradedCondition['severity'] {
  if (stored === 'error') return 'error';
  return stored === 'warning' || escalated === 'warn' ? 'warn' : 'info';
}

/**
 * The escalation this report applies to one condition, before its stored
 * severity is taken into account — see {@link strongerSeverity}, which is what
 * keeps this from ever LOWERING a row.
 *
 * @param row - The stored condition
 * @param shapeOf - Reference key → whether the token is path-shaped
 * @param keyOf - Root-relative path → its `contentKey`
 * @returns `warn` for a path-shaped in-root unresolved import, else `info`
 */
function severityFor(
  row: RealizationConditionRow,
  shapeOf: ReadonlyMap<string, boolean>,
  keyOf: ReadonlyMap<string, string>,
): 'info' | 'warn' {
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
    ? 'warn'
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
function referenceKey(reference: BlobReferenceRow): string {
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
