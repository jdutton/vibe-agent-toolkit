/**
 * Evaluating the authored-link lens over a populated projection, so SQL can ask
 * about edges.
 *
 * ## Why the CLI does this rather than the population
 *
 * `edges` and `edge_resolutions` are derived per lens, and the set of lenses is
 * not known at population time — zones.md §2: *"A lens may be declared in config
 * **or invented on demand** to answer a question nobody anticipated."* So a
 * population cannot produce them without first inventing the lens, which is a
 * question, not a fact. Inventing one here costs a definition and a pass over
 * rows already in memory; it commits the data model to nothing, and the rows go
 * into the per-run in-memory database that `projection-query.ts` guarantees
 * holds this tree and nothing else.
 *
 * ## One lens per extent, and the extent is the thing worth naming
 *
 * A corpus has more than one extent — this repository has two, `filesystem`
 * (the tracked tree) and `agentic-convention` (the CLAUDE.md closure) — and an
 * edge relation over one is a different relation from an edge relation over the
 * other. Evaluating every extent and keying the rows on the lens's own
 * `contextId` means a caller SELECTs the population they meant, rather than
 * silently getting whichever one happened to be evaluated. `lens_contexts` says
 * which lenses exist and which extent each reads over, so the join is
 * discoverable from SQL alone.
 *
 * ⚠️ **Only `species: 'extent'` rows are read over.** A lens over a lens is not
 * a thing this evaluation models, and `resolution_contexts` holds no lens rows
 * anyway — nothing in the population mints one. The filter is there so that
 * stops being true loudly rather than silently if something ever does.
 */

import {
  AUTHORED_EDGE_FORMS,
  buildReferenceIndex,
  resolveEdges,
  type Projection,
  type ResolutionContextRow,
} from '@vibe-agent-toolkit/resources';

/**
 * The lens kind these evaluations declare.
 *
 * `ZoneKindSchema` is an open vocabulary, so this names the POLICY rather than
 * the mechanism: what makes two of these lenses the same is that both admit the
 * authored forms and nothing else. A lens that promoted bare tokens would be a
 * different kind, not a variant of this one, because the two answer differently
 * by an order of magnitude and a reader comparing them must be able to tell.
 */
const AUTHORED_LENS_KIND = 'authored-link';

/** The rows one sweep of the corpus produced, ready for `writeDerived`. */
export interface EvaluatedLenses {
  readonly lensContexts: readonly ResolutionContextRow[];
  readonly edges: readonly Record<string, unknown>[];
  readonly edgeResolutions: readonly Record<string, unknown>[];
}

/**
 * Evaluate the authored-link lens over every extent in a projection.
 *
 * @param projection - A populated projection
 * @returns The lens rows and the two relations, in step with each other
 */
export function evaluateAuthoredLenses(projection: Projection): EvaluatedLenses {
  const lensContexts: ResolutionContextRow[] = [];
  const edges: Record<string, unknown>[] = [];
  const edgeResolutions: Record<string, unknown>[] = [];

  // Built ONCE for every lens. It is a pure function of `blob_references` and
  // reads nothing from a lens, so rebuilding it per extent is duplicated work a
  // one-member extent would pay in full — 43 ms at one extent against 713 ms at
  // ten, measured on this repository.
  const referencesByBlob = buildReferenceIndex(projection);

  for (const context of projection.resolutionContexts) {
    if (context.species !== 'extent') continue;
    const contextId = authoredLensId(context.contextId);
    lensContexts.push({
      contextId,
      species: 'lens',
      kind: AUTHORED_LENS_KIND,
      rootId: context.rootId,
      extentContextId: context.contextId,
      // Null because this lens's kind is not `tree`; the schema refuses a role
      // on any other kind, which is that check doing its job rather than a
      // field being forgotten.
      role: null,
    });
    const relation = resolveEdges(projection, {
      contextId,
      extentContextId: context.contextId,
      forms: AUTHORED_EDGE_FORMS,
      // Ordinary markdown. `claude-import` is the other dialect and belongs to
      // the `@`-import forms, which the authored-only policy does not admit.
      dialect: 'href',
    }, { referencesByBlob });
    edges.push(...relation.edges);
    edgeResolutions.push(...relation.edgeResolutions);
  }

  return { lensContexts, edges, edgeResolutions };
}

/**
 * The lens id for one extent's authored-link view.
 *
 * Derived from the extent's own id rather than minted fresh, so the same tree
 * produces the same lens id on every run and a reader can predict it. It is
 * NOT a digest: nothing here needs collision resistance, and a readable id is
 * what makes `WHERE contextId = …` writable by hand.
 *
 * @param extentContextId - The extent this lens reads over
 * @returns The lens's `contextId`
 */
export function authoredLensId(extentContextId: string): string {
  return `lens-${AUTHORED_LENS_KIND}-${extentContextId}`;
}
