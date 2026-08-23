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
import type { BlobReferenceRow } from '../schemas/projection-blobs.js';
import type {
  RealizationConditionRow,
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
  const realization = projection.resourceRealizations.find((row) => row.path === inputPath);
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
  const imports = applyImportClosures(projection, admittedIds, admissions);

  return {
    kind: 'answer',
    input: inputPath,
    directory,
    file,
    rows: rowsFor(projection, admissions),
    conditions: gradeConditions(projection, imports.walkedExtents),
    overBudgetRules: overBudget,
    unattributedImports: imports.unattributed,
  };
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
 * @param projection - The populated projection
 * @param admittedIds - Resource ids the ancestry and rule passes already admitted
 * @param admissions - The admission map, mutated in place
 * @returns The root-relative path of every import member `closureProvenance`
 *   could not attribute a parent to — deduplicated, because one path may be an
 *   unattributable member of two different closures and the field is a SET of
 *   paths the answer cannot explain, not a tally of how often it failed — plus
 *   the extents actually walked, which is what scopes {@link gradeConditions}
 */
function applyImportClosures(
  projection: Projection,
  admittedIds: ReadonlySet<string>,
  admissions: Map<string, Admission[]>,
): { unattributed: string[]; walkedExtents: ReadonlySet<string> } {
  const unattributed = new Set<string>();
  const walkedExtents = new Set<string>();
  for (const closure of importClosuresFor(projection, admittedIds)) {
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
 * The import closures rooted at the resources this query already admitted.
 *
 * Only those: an import extent rooted at a `CLAUDE.md` the query never reached is
 * an extent for some other directory's session, and charging it here is exactly
 * the tree-global over-report `rule-scope` exists to prevent.
 *
 * The declaration is read back off `zone_provenance.parameterSet` rather than
 * rebuilt, because that is what the population actually ran under: a rebuilt one
 * would silently disagree with a store-answered projection populated under a
 * different `referenceDialect`.
 *
 * @param projection - The populated projection
 * @param admittedIds - Resource ids the ancestry and rule passes already admitted
 * @returns One entry per relevant closure — its extent id, and each member's
 *   admission
 * @throws When the projection carries no root. `merge.ts` is the only `addRoot`
 *   caller and adds exactly one, so this is an invariant rather than a reachable
 *   failure — and answering "zero import closures" instead would be a silent
 *   confident zero, indistinguishable from a tree that genuinely imports nothing.
 *   That is the one answer shape this query's `unknown` result exists to avoid
 */
function importClosuresFor(
  projection: Projection,
  admittedIds: ReadonlySet<string>,
): Array<{ extentId: string; members: Array<{ resourceId: string; path: string; admission: Admission }> }> {
  const root = projection.roots[0]?.path;
  if (root === undefined) {
    throw new Error(
      'whatLoadsAt received a projection with no root, which violates the projection invariant that'
      + ' every population has exactly one (`merge.ts` is the sole `addRoot` caller). Import closures'
      + ' resolve references against that root, so answering zero closures here would report "nothing'
      + ' is imported" for a tree nobody looked at.',
    );
  }
  const pathOf = new Map(projection.resourceRealizations.map((row) => [row.resourceId, row.path]));
  const idOf = new Map(projection.resourceRealizations.map((row) => [row.path, row.resourceId]));

  const closures = [];
  for (const provenanceRow of projection.zoneProvenance) {
    if (!provenanceRow.contributorId.startsWith(`${CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX}:`)) continue;
    const declaration = ExtentDeclarationSchema.parse(provenanceRow.parameterSet);
    const rootId = idOf.get(declaration.closureFrom);
    if (rootId === undefined || !admittedIds.has(rootId)) continue;

    const provenance = closureProvenance({
      root,
      resourceRealizations: projection.resourceRealizations,
      blobReferences: projection.blobReferences,
      declaration,
    });
    closures.push({
      extentId: provenanceRow.contextId,
      members: membersOf(projection, provenanceRow.contextId, declaration.closureFrom, provenance, pathOf),
    });
  }
  return closures;
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
 * @param projection - The populated projection
 * @param extentId - The closure's `resolution_contexts.contextId`
 * @param rootPath - The closure's declared root
 * @param provenance - {@link closureProvenance}'s map for this closure
 * @param pathOf - `resourceId` → root-relative path
 * @returns Each member with its import admission
 */
function membersOf(
  projection: Projection,
  extentId: string,
  rootPath: string,
  provenance: ReadonlyMap<string, ImportProvenance>,
  pathOf: ReadonlyMap<string, string>,
): Array<{ resourceId: string; path: string; admission: Admission }> {
  const members = [];
  for (const membership of projection.resourceExtents) {
    if (membership.extentId !== extentId) continue;
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
 * @param projection - The populated projection
 * @param admissions - `resourceId` → every admission that reached it
 * @returns One row per identity, path-ordered
 */
function rowsFor(
  projection: Projection,
  admissions: ReadonlyMap<string, readonly Admission[]>,
): LoadedRow[] {
  const realizationOf = new Map<string, ResourceRealizationRow>();
  for (const row of projection.resourceRealizations) {
    if (!realizationOf.has(row.resourceId)) realizationOf.set(row.resourceId, row);
  }
  const blobByKey = new Map(projection.blobs.map((row) => [row.contentKey, row]));
  const idOf = new Map(projection.resourceRealizations.map((row) => [row.path, row.resourceId]));
  const classes = loadClasses(admissions, idOf);

  const rows: LoadedRow[] = [];
  for (const [resourceId, list] of admissions) {
    const realization = realizationOf.get(resourceId);
    if (realization === undefined) continue;
    const blob = realization.contentKey === null ? undefined : blobByKey.get(realization.contentKey);
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
 * @param projection - The populated projection
 * @param walkedExtents - Context ids of the import closures this query charged
 * @returns Every in-scope condition, with its report severity
 */
function gradeConditions(
  projection: Projection,
  walkedExtents: ReadonlySet<string>,
): GradedCondition[] {
  const declined = unwalkedImportExtents(projection, walkedExtents);
  const shapeOf = new Map<string, boolean>();
  for (const reference of projection.blobReferences) {
    shapeOf.set(referenceKey(reference), reference.hasExtension || reference.slashCount > 0);
  }
  const keyOf = new Map(
    projection.resourceRealizations
      .filter((row) => row.contentKey !== null)
      .map((row) => [row.path, row.contentKey as string]),
  );

  return projection.realizationConditions
    .filter((row) => !declined.has(row.extentId))
    .map((row) => ({
      code: row.code,
      severity: strongerSeverity(row.severity, severityFor(row, shapeOf, keyOf)),
      path: row.path,
      sourcePath: row.sourcePath,
      sourceLine: row.sourceLine,
      sourceRef: row.sourceRef,
      message: row.message,
    }));
}

/**
 * The import extents this query did NOT walk — the conditions to drop.
 *
 * Expressed as the extents to EXCLUDE rather than the ones to include, because
 * the answer keeps every condition from every non-closure extent and only an
 * import extent can be "some other directory's session".
 *
 * @param projection - The populated projection
 * @param walkedExtents - Context ids of the import closures this query charged
 * @returns Context ids of every import extent this query declined
 */
function unwalkedImportExtents(
  projection: Projection,
  walkedExtents: ReadonlySet<string>,
): Set<string> {
  const declined = new Set<string>();
  for (const row of projection.zoneProvenance) {
    if (!row.contributorId.startsWith(`${CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX}:`)) continue;
    if (!walkedExtents.has(row.contextId)) declined.add(row.contextId);
  }
  return declined;
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
