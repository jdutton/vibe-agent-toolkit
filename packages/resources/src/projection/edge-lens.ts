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
 * @param projection - A populated projection; every input read is a materialised
 *   column, so a rehydrated projection answers identically to a derived one
 * @param lens - What this lens admits and how it reads a token
 * @returns The two relations. Empty when the projection has no root, because a
 *   reference resolves against one and there is nothing to resolve against
 */
export function resolveEdges(projection: Projection, lens: EdgeLens): EdgeRelation {
  const root = projection.roots[0]?.path;
  if (root === undefined) return { edges: [], edgeResolutions: [] };

  const referencesByBlob = groupReferencesByBlob(projection.blobReferences);
  // One map, not a Set beside it: "is this path realized" and "which identity
  // realizes it" are the same lookup, and two structures built from one filter
  // is two things to keep in step for no gain.
  const resourceByPath = new Map(
    projection.resourceRealizations
      .filter((row) => row.extentId === lens.extentContextId)
      .map((row) => [row.path, row.resourceId] as const),
  );

  const edges: EdgeRow[] = [];
  const edgeResolutions: EdgeResolutionRow[] = [];

  for (const realization of sourceRealizations(projection, lens)) {
    const references = referencesByBlob.get(realization.contentKey ?? '') ?? [];
    for (const reference of references) {
      if (!lens.forms.has(reference.syntacticForm)) continue;
      edges.push({
        src: realization.resourceId,
        refOrdinal: reference.ordinal,
        contextId: lens.contextId,
        kind: NON_LOCAL_REF.test(reference.rawRef) ? 'external' : 'local_file',
        origin: 'authored',
      });
      const destination = destinationFor(reference, realization.path, root, lens, resourceByPath);
      if (destination === undefined) continue;
      edgeResolutions.push({
        src: realization.resourceId,
        refOrdinal: reference.ordinal,
        contextId: lens.contextId,
        // 0 for every row today: authored resolution is single-candidate by
        // construction. The column exists for wiki title resolution, which is
        // many-candidate by nature — N=1 is that case, not a separate shape.
        candidateOrdinal: 0,
        ...destination,
        // Null, and deliberately not a fabricated tier or a fabricated 1.0.
        // This lens has no reachability model and did not infer anything, so
        // "has a tier" keeps meaning "reachability was assessed" and "has a
        // score" keeps meaning "was inferred".
        tier: null,
        score: null,
      });
    }
  }

  return { edges, edgeResolutions };
}

/**
 * Which realizations this lens reads references OUT of.
 *
 * Restricted to the lens's extent, and to realizations that actually carry
 * bytes: a `contentKey` of null means nothing was parsed, so there are no
 * references to read and an edge from it would be invented rather than observed.
 *
 * 🪤 **Deduplicated on `(resourceId, contentKey)`.** `resource_realizations` is
 * keyed on `(extentId, path)` while `resources` is one identity per file, so ONE
 * extent can hold two paths for one identity — a symlink and its target both
 * canonicalize to the same `resourceId`. Both realizations carry the same
 * references, and emitting both would violate `edges`' own
 * `(src, refOrdinal, contextId)` key with two rows that differ only in the path
 * resolution ran from. The FIRST in projection order wins, which is the same
 * tie-break `closure-extent.ts` applies when it takes `byPath.get(p)?.[0]`.
 *
 * @param projection - The projection being evaluated
 * @param lens - The lens, for its extent
 * @returns One realization per identity, in projection order
 */
function sourceRealizations(projection: Projection, lens: EdgeLens): ResourceRealizationRow[] {
  const seen = new Set<string>();
  const chosen: ResourceRealizationRow[] = [];
  for (const row of projection.resourceRealizations) {
    if (row.extentId !== lens.extentContextId) continue;
    if (row.contentKey === null) continue;
    if (seen.has(row.resourceId)) continue;
    seen.add(row.resourceId);
    chosen.push(row);
  }
  return chosen;
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
