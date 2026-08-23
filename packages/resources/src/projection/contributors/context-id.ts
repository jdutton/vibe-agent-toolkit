/**
 * The one place an extent's `resolution_contexts.contextId` is spelled.
 *
 * `ResolutionContextRowSchema.contextId` is documented as *"unique within a
 * federated query"*, and `ProjectionBuilder`'s `#contexts` table keys on that
 * column **alone**, keep-first. So an id that omits the root is not a style
 * difference: in a projection federating two roots that both depend on `react`,
 * the second root's package extent loses the key race, its context row is
 * dropped, and its membership rows then point at the *other* root's extent.
 *
 * Three contributors landed in parallel and invented three schemes for this one
 * key space — `ctx-filesystem-<rootId>`, `ctx-git-<rootId>` and
 * `extent:package:<name>`, the last of them root-blind. This module is the
 * consolidation: one scheme, and `rootId` is never optional.
 *
 * ## The id is derived, never allocated
 *
 * Two populations of the same corpus must name the same extent, or their
 * `zone_provenance` digests are not comparable — which is the entire point of
 * zones.md §7.4. A counter or a UUID would make every run's extents distinct
 * and the convergence oracle would compare nothing.
 *
 * ## Why the discriminator hangs off `#` rather than another `-`
 *
 * A discriminator is real data — an npm package name, so `@scope/pkg-name`,
 * containing both `/` and `-`. With `-` as the separator the mapping is not
 * injective: `rootIdFor` emits `root-` + 32 hex characters, so a parse anchored
 * on that fixed shape reads `ctx-package-<rootId>-root-<32 hex>` either as
 * "kind `package`, this root, discriminator `root-<32 hex>`" or as "kind
 * `package-<rootId>`, root `root-<32 hex>`, no discriminator". `#` cannot occur
 * in `root-<32 hex>` and does not occur in any `resolution_contexts.kind`
 * token, so splitting at the **first** `#` recovers the discriminator exactly —
 * even one that itself contains `-`, `/` or a further `#`.
 */

/** Every extent context id begins here, so one prefix scan identifies the key space. */
const CONTEXT_ID_PREFIX = 'ctx';

/**
 * Separates the `(kind, rootId)` pair from a within-root discriminator.
 *
 * Deliberately a character that occurs in neither part: see the module note.
 */
const DISCRIMINATOR_SEPARATOR = '#';

/**
 * The stable context id of one extent.
 *
 * @param kind - The `resolution_contexts.kind` this extent has, e.g. `filesystem`
 * @param rootId - From `ResourceIdentityMap.rootId`. Required, always: it is
 *   what keeps two roots' same-named extents apart in a federated projection
 * @param discriminator - Distinguishes extents of one kind **within** one root —
 *   a package name for the package extent. Omitted where a root has exactly one
 *   extent of the kind, as for `filesystem` and `git`
 * @returns `ctx-<kind>-<rootId>`, or `ctx-<kind>-<rootId>#<discriminator>`
 */
export function extentContextId(kind: string, rootId: string, discriminator?: string): string {
  const scoped = `${CONTEXT_ID_PREFIX}-${kind}-${rootId}`;
  return discriminator === undefined
    ? scoped
    : `${scoped}${DISCRIMINATOR_SEPARATOR}${discriminator}`;
}
