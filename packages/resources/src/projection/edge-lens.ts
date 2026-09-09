/**
 * `resolveEdges(projection, lens)` — the edge relation, COMPUTED, never stored.
 *
 * ## Why this returns rows instead of writing them
 *
 * `projection.ts` states it outright: `edges`, `edge_resolutions` and
 * `lens_entry_points` are *"the output of evaluating a lens rather than rows
 * anything populates. Declaring empty slots for them would state the
 * opposite."* `closure-extent.ts` refused an `extent_edges` table on the same
 * ground and re-runs its traversal in the query instead, and `ExtentContribution`
 * carries no edge field at all — a contributor literally cannot emit one.
 *
 * So this is not a producer and adds no table. It is the same shape
 * `claude-context-query.ts` already ships: *"nothing here is a stored table …
 * Ruling B's position is about what the PROJECTION materialises, and this adds
 * no row to it."* A caller holds the result for as long as it needs the answer
 * and drops it; two callers over one projection get identical rows, because
 * every input is a materialised column.
 *
 * ## Edge volume is a POLICY choice, not a corpus property
 *
 * zones.md §5 measures the span: **authored forms alone are ~11k references on
 * the primary adopter; admitting every lexer-derived token is ~115k** — an order
 * of magnitude decided before any code runs. So a lens *declares* which origins
 * it admits, and `AUTHORED_EDGE_FORMS` is the conservative floor rather than a
 * default nobody chose. ⛔ A benchmark that does not state its policy is
 * measuring an arbitrary point in a 10× range.
 *
 * ⚠️ Code-span traversal is NOT a second axis. Every authored form is 0/0 across
 * `inCodeSpan`/`inFence` — an AST link inside code yields no link node at all —
 * so under an authored-only policy the lever changes the count by exactly zero.
 * It only becomes meaningful once bare tokens are promoted, and then it is a
 * sub-lever of that decision.
 */

import type { ReferenceDialect } from '../schemas/project-config.js';
import type { BlobReferenceRow, ReferenceSyntacticForm } from '../schemas/projection-blobs.js';
import type { EdgeResolutionRow, EdgeRow } from '../schemas/projection-edges.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';

import {
  externalDestination,
  fragmentOf,
  outOfCorpusDestination,
  resourceDestination,
  type EdgeDestination,
} from './edge-destination.js';
import type { Projection } from './projection.js';
import { resolveReferencePath } from './reference-resolution.js';

/**
 * The forms a human wrote as a reference, which is the authored-only policy.
 *
 * ⛔ **`markdown-definition` is deliberately absent, and this is the one place
 * it is easy to get wrong.** `claude-context-discovery.ts`'s `FOLLOWED_FORMS`
 * *does* include it, correctly — for **closure traversal** a definition is a
 * real way to reach a file, so a walk that skipped it would miss members. But
 * zones.md §5 rules that a definition is **not an edge**: `[a]: /url` is
 * resolution machinery, and the edge belongs to the *use* (`[text][a]`).
 * Counting both double-counts every inbound reference-style link and inflates
 * every reachability walk. Reusing `FOLLOWED_FORMS` here would import that
 * defect wholesale, which is why this set is declared rather than shared.
 *
 * ⚠️ It is also why rewriting repeated links into reference form — a
 * token-economy transform — must not change the link graph: that transform
 * *creates* definition rows, and a transform that improves a document must not
 * change what it points at.
 */
export const AUTHORED_EDGE_FORMS: ReadonlySet<ReferenceSyntacticForm> = new Set([
  'markdown-link',
  'markdown-link-reference',
  'html-link',
]);

/**
 * A scheme-bearing or protocol-relative reference, matched on the raw token.
 *
 * The same production `closure-extent.ts` tests with, and for the same reason:
 * `blob_references` records the raw token and not the link type, so without this
 * every external URL resolves against the referring directory, finds nothing,
 * and is reported as a broken *local* reference — a false claim that would fire
 * on essentially every real document.
 */
const NON_LOCAL_REF = /^(?:\/\/|[a-z][\w+.-]*:)/iu;

/** What a lens admits and how it reads a token. */
export interface EdgeLens {
  /** `resolution_contexts.contextId` of the lens itself — every row carries it. */
  readonly contextId: string;
  /** The extent this lens resolves within, i.e. the lens row's `extentContextId`. */
  readonly extentContextId: string;
  /** Which syntactic forms become edges. See {@link AUTHORED_EDGE_FORMS}. */
  readonly forms: ReadonlySet<ReferenceSyntacticForm>;
  /** How a token is read. `href` is ordinary markdown. */
  readonly dialect: ReferenceDialect;
}

/**
 * Work a caller evaluating SEVERAL lenses over one projection can share.
 *
 * 🪤 The reference index is a pure function of `blob_references` and reads
 * nothing from the lens, so rebuilding it per lens is duplicated work that a
 * one-member extent pays in full — and the number of extents is config-driven
 * and unbounded (`package-extent.ts` mints one per declared spec). Measured on
 * this repository (2,300 files, 31,496 references) with overlapping full-tree
 * extents: **43 ms at one extent, 713 ms at ten**, before the write.
 *
 * Optional rather than required, because a single-lens caller should not have to
 * know the index exists. {@link buildReferenceIndex} is how a multi-lens caller
 * builds one.
 */
export interface EdgeEvaluationOptions {
  /** Shared across lenses — see {@link buildReferenceIndex}. */
  readonly referencesByBlob?: ReadonlyMap<string, BlobReferenceRow[]>;
}

/**
 * Build the reference index once, for a caller evaluating several lenses.
 *
 * @param projection - The projection every lens will be evaluated over
 * @returns The index to pass as `options.referencesByBlob`
 */
export function buildReferenceIndex(
  projection: Projection,
): ReadonlyMap<string, BlobReferenceRow[]> {
  return groupReferencesByBlob(projection.blobReferences);
}

/** One evaluation's output — the two relations, in step with each other. */
export interface EdgeRelation {
  readonly edges: readonly EdgeRow[];
  readonly edgeResolutions: readonly EdgeResolutionRow[];
}

/**
 * Evaluate the edge relation for one lens over one projection.
 *
 * ## An edge with no candidate row is a REAL state, not a gap
 *
 * Three outcomes reach this function and only two produce a candidate:
 *
 * - the token resolved to a path, inside or outside the root → **one candidate**,
 *   classed `resource` when a realization holds it and `out-of-corpus` when none
 *   does (a target the corpus stops short of, or a declared-but-unwritten one);
 * - the token carried a scheme → **one candidate**, classed `external`;
 * - the token named no file at all — an anchor-only href, or a dialect that
 *   declined it → **no candidate**, and the edge stands alone.
 *
 * That last case is why the edge and its candidates are separate relations. It
 * says *"the lens looked and found nothing to point at"*, which is a different
 * fact from *"it points at something this corpus does not contain"*, and one
 * scalar destination column could not tell them apart. Neither is an existence
 * verdict: nothing here stats anything outside the population.
 *
 * ## 🚨 `out-of-corpus` is relative to THIS LENS'S EXTENT, not to the tree
 *
 * The corpus a destination is judged against is the lens's extent, so the same
 * link yields a different class under two lenses, and reading the count as
 * "broken" is only sound for a lens whose extent IS the tree. Measured on the
 * primary adopter: the filesystem lens reports **51** out-of-corpus against
 * 10,317 resources, and those 51 really are dangling; the agentic-convention
 * lens over the same tree reports **1,430** against 511, and essentially none
 * of those are broken — they are documents the always-loaded context links to
 * that the closure does not itself contain, which is the normal and correct
 * shape of a CLAUDE.md tree.
 *
 * ⇒ **Never quote an out-of-corpus count without naming the lens.** The number
 * moves 28-fold between two lenses over one corpus, and only one of the two
 * readings is a defect count.
 *
 * @param projection - A populated projection; every input read is a materialised
 *   column, so a rehydrated projection answers identically to a derived one
 * @param lens - What this lens admits and how it reads a token
 * @param options - Work shareable across lenses over one projection
 * @returns The two relations. Empty when the projection has no root, because a
 *   reference resolves against one and there is nothing to resolve against
 */
export function resolveEdges(
  projection: Projection,
  lens: EdgeLens,
  options?: EdgeEvaluationOptions,
): EdgeRelation {
  const root = projection.roots[0]?.path;
  if (root === undefined) return { edges: [], edgeResolutions: [] };

  const referencesByBlob = options?.referencesByBlob ?? groupReferencesByBlob(projection.blobReferences);
  const visible = visibleRealizations(projection, lens);

  // One map, not a Set beside it: "is this path realized" and "which identity
  // realizes it" are the same lookup, and two structures built from one filter
  // is two things to keep in step for no gain.
  //
  // EVERY visible path, not just the chosen one: a symlink and its target are
  // two paths for one identity, and a link written to either resolves to it.
  // Built from the same `visible` set the sources come from, so "which
  // realizations does this lens see" is answered once.
  const resourceByPath = new Map<string, string>();
  for (const rows of visible.values()) {
    for (const row of rows) resourceByPath.set(row.path, row.resourceId);
  }

  const edges: EdgeRow[] = [];
  const edgeResolutions: EdgeResolutionRow[] = [];

  for (const realization of sourceRealizations(visible)) {
    for (const reference of referencesByBlob.get(realization.contentKey ?? '') ?? []) {
      if (!lens.forms.has(reference.syntacticForm)) continue;
      emitEdge({ edges, edgeResolutions }, { reference, realization, root, lens, resourceByPath });
    }
  }

  return { edges, edgeResolutions };
}

/**
 * Append one reference's edge, and its candidate when it has one.
 *
 * Split out of {@link resolveEdges} to keep that function under the cognitive
 * complexity ceiling — the two loops, the form filter and the destination
 * branch together crossed it — and because "what one reference contributes" is
 * a complete thought on its own.
 *
 * @param into - The two relations being built, appended in step
 * @param what - The reference, the realization it was read from, and the lens
 *   context needed to resolve it
 */
function emitEdge(
  into: { edges: EdgeRow[]; edgeResolutions: EdgeResolutionRow[] },
  what: {
    reference: BlobReferenceRow;
    realization: ResourceRealizationRow;
    root: string;
    lens: EdgeLens;
    resourceByPath: ReadonlyMap<string, string>;
  },
): void {
  const { reference, realization, root, lens, resourceByPath } = what;
  into.edges.push({
    src: realization.resourceId,
    refOrdinal: reference.ordinal,
    contextId: lens.contextId,
    kind: NON_LOCAL_REF.test(reference.rawRef) ? 'external' : 'local_file',
    origin: 'authored',
  });

  const destination = destinationFor(reference, realization.path, root, lens, resourceByPath);
  if (destination === undefined) return;

  into.edgeResolutions.push({
    src: realization.resourceId,
    refOrdinal: reference.ordinal,
    contextId: lens.contextId,
    // 0 for every row today: authored resolution is single-candidate by
    // construction. The column exists for wiki title resolution, which is
    // many-candidate by nature — N=1 is that case, not a separate shape.
    candidateOrdinal: 0,
    ...destination,
    // Null, and deliberately not a fabricated tier or a fabricated 1.0. This
    // lens has no reachability model and did not infer anything, so "has a
    // tier" keeps meaning "reachability was assessed" and "has a score" keeps
    // meaning "was inferred".
    tier: null,
    score: null,
  });
}

/**
 * The realizations this lens can SEE, per member identity.
 *
 * ## 🚨 Membership decides the extent; the realization's own `extentId` decides
 * which BYTES those members are read as. Both halves are load-bearing.
 *
 * A realization says "this identity was found at this path by the pass that
 * recorded it"; membership (`resource_extents`) says "this identity is in this
 * extent". For the filesystem extent the two coincide, so filtering
 * realizations by `extentId` looked right. It is not: measured on this
 * repository, the `agentic-convention` extent has **160 members and ZERO
 * realizations of its own**, because a closure extent contributes memberships
 * over identities the filesystem extent already realized. A lens over it
 * returned no edges at all — an empty answer shaped exactly like a valid one.
 *
 * ⛔ **But dropping the extent filter outright is the OPPOSITE error, and it is
 * worse because it emits wrong rows rather than none.** zones.md §4: one source
 * file bundled into skills is *one identity with several realizations*, and the
 * packager REWRITES content, so a `dist` realization has a different path,
 * different bytes and a different content key. With no preference at all, a
 * filesystem lens could read a member's *packaged* bytes and resolve its links
 * from `dist/skills/x/` — reporting `out-of-corpus` for links that are fine in
 * source, under a lens whose extent is the filesystem. zones.md §2 says
 * per-lens resolution exists to EXPOSE that divergence, not to manufacture it.
 *
 * ⇒ The rule is **prefer the lens's own extent, and fall back to any other only
 * when the member has no realization there.** That serves both cases: an
 * ordinary extent reads its own bytes, and a closure extent — which owns none —
 * still reads its members.
 *
 * @param projection - The projection being evaluated
 * @param lens - The lens, for its extent
 * @returns Member identity → the realizations this lens reads it through,
 *   sorted by path so the choice does not depend on projection order
 */
function visibleRealizations(
  projection: Projection,
  lens: EdgeLens,
): ReadonlyMap<string, readonly ResourceRealizationRow[]> {
  const members = extentMembers(projection, lens);
  const own = new Map<string, ResourceRealizationRow[]>();
  const foreign = new Map<string, ResourceRealizationRow[]>();
  for (const row of projection.resourceRealizations) {
    if (!members.has(row.resourceId)) continue;
    // 🚨 A row with no `contentKey` STAYS. It is excluded as a SOURCE — see
    // `sourceRealizations` — but it is a perfectly real link TARGET, and
    // dropping it here reported every link to an image, a PDF or any other
    // unparsed member as `out-of-corpus`. Measured on the primary adopter, that
    // single conflation moved the out-of-corpus count from 51 to 119 and was
    // caught only by re-running the analytics after the fix.
    //
    // 🔑 "Can I read references OUT of this?" and "can a reference point AT
    // this?" are different questions, and only the first needs bytes.
    const bucket = row.extentId === lens.extentContextId ? own : foreign;
    const existing = bucket.get(row.resourceId);
    if (existing === undefined) bucket.set(row.resourceId, [row]);
    else existing.push(row);
  }
  // The fallback is per MEMBER, not global: a corpus where some members are
  // realized in this extent and others only elsewhere must serve both.
  for (const [resourceId, rows] of foreign) {
    if (!own.has(resourceId)) own.set(resourceId, rows);
  }
  for (const rows of own.values()) rows.sort(byPath);
  return own;
}

/**
 * Which realization each member is READ from — one per identity.
 *
 * 🚨 **The choice is a resolution BASE, not a cosmetic tie-break, so it must not
 * depend on projection order.** An identity realized at both `guide.md` and
 * `docs/link.md` resolves `[t](./target.md)` to `target.md` or `docs/target.md`
 * purely by which row is picked — two different destinations, one of them
 * wrong. And projection order is genuinely unstable: `selectExtentSql` carries
 * no `ORDER BY`, so a rehydrated projection returns rows in primary-key order
 * (`extentId`, then `path`) while a freshly derived one returns them in
 * contributor-emission order. "The first row wins" would therefore give one
 * corpus two answers depending on whether a store happened to hit.
 *
 * ⇒ The lowest path wins, which is total, stable, and independent of how the
 * rows arrived. ⚠️ It is still arbitrary in the sense that no path is *more*
 * correct than another for a symlinked identity — but it is arbitrary the same
 * way every time, which is the property a reader comparing two runs needs.
 *
 * Deduplication is required, not merely tidy: `edges` keys on
 * `(src, refOrdinal, contextId)`, and two realizations of one identity carry the
 * same references, so emitting both would put two rows under one key.
 *
 * @param visible - What each member is visible as, already sorted by path
 * @returns One realization per member, ordered by identity so the emitted rows
 *   do not depend on projection order either
 */
function sourceRealizations(
  visible: ReadonlyMap<string, readonly ResourceRealizationRow[]>,
): ResourceRealizationRow[] {
  const chosen: ResourceRealizationRow[] = [];
  for (const resourceId of [...visible.keys()].sort((left, right) => left.localeCompare(right))) {
    // ⚠️ The `contentKey` filter belongs HERE and not in `visibleRealizations`:
    // a member with no parsed bytes has no references to read, so an edge FROM
    // it would be invented rather than observed — but it remains a legitimate
    // destination, which is why the path index keeps it.
    const first = visible.get(resourceId)?.find((row) => row.contentKey !== null);
    if (first !== undefined) chosen.push(first);
  }
  return chosen;
}

/**
 * Order two realizations by path, so a member's chosen row is deterministic.
 *
 * @param left - One realization
 * @param right - The other
 * @returns Negative when `left` sorts first
 */
function byPath(left: ResourceRealizationRow, right: ResourceRealizationRow): number {
  return left.path.localeCompare(right.path);
}

/**
 * The identities belonging to the lens's extent.
 *
 * @param projection - The projection being evaluated
 * @param lens - The lens, for its extent
 * @returns Every `resourceId` the extent claims
 */
function extentMembers(projection: Projection, lens: EdgeLens): ReadonlySet<string> {
  const members = new Set<string>();
  for (const row of projection.resourceExtents) {
    if (row.extentId === lens.extentContextId) members.add(row.resourceId);
  }
  return members;
}

/**
 * Group every reference by the blob that holds it, so the walk is one pass.
 *
 * @param references - `blob_references`, whole
 * @returns Content key → its references, in ordinal order as stored
 */
function groupReferencesByBlob(
  references: readonly BlobReferenceRow[],
): ReadonlyMap<string, BlobReferenceRow[]> {
  const byBlob = new Map<string, BlobReferenceRow[]>();
  for (const reference of references) {
    const existing = byBlob.get(reference.blob);
    if (existing === undefined) byBlob.set(reference.blob, [reference]);
    else existing.push(reference);
  }
  return byBlob;
}

/**
 * Classify one reference's destination, or report that it has none.
 *
 * @param reference - The reference row
 * @param fromPath - Root-relative path of the file holding it
 * @param root - Absolute corpus root
 * @param lens - The lens, for its dialect
 * @param resourceByPath - The lens extent's realizations, path → identity
 * @returns The destination columns, or undefined when the token named no file
 */
function destinationFor(
  reference: BlobReferenceRow,
  fromPath: string,
  root: string,
  lens: EdgeLens,
  resourceByPath: ReadonlyMap<string, string>,
): EdgeDestination | undefined {
  if (NON_LOCAL_REF.test(reference.rawRef)) return externalDestination(reference.rawRef);

  const resolution = resolveReferencePath(lens.dialect, reference.rawRef, fromPath, root);
  if (resolution.kind === 'unresolvable') return undefined;
  if (resolution.kind === 'outside-root') {
    return outOfCorpusDestination(resolution.path, fragmentOf(reference.rawRef));
  }
  const resourceId = resourceByPath.get(resolution.path);
  return resourceId === undefined
    // Inside the root and realized by nothing: the declared-but-unwritten case.
    // Still `out-of-corpus` — the corpus does not contain it — and still NOT a
    // claim that it is dead, which nothing here looked to find out.
    ? outOfCorpusDestination(resolution.path, fragmentOf(reference.rawRef))
    : resourceDestination(resourceId, fragmentOf(reference.rawRef));
}
