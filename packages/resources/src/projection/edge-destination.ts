/**
 * The three destination classes of `edge_resolutions`, as builders.
 *
 * `EdgeResolutionRowSchema` states two invariants and enforces them in a
 * `superRefine`: `dstResource` is non-null **iff** `dstKind` is `resource`, and
 * in that class `dstKey` must equal `dstResource`. A `superRefine` catches a
 * violation at the boundary; these builders make one **unconstructible**, which
 * is the difference between a producer that fails validation and a producer that
 * cannot express the mistake. Every caller that emits a candidate should go
 * through one of the three rather than assembling the four columns by hand.
 *
 * ## Why this is pure, and takes an already-resolved outcome
 *
 * Resolution — turning a `rawRef` into a path, and a path into a realization —
 * already exists in `contributors/closure-extent.ts`, and duplicating it would
 * give the corpus two answers to one question. These functions take the outcome
 * of that resolution and answer only the question it does not: *how is this
 * destination identified, across the three namespaces a `GROUP BY` has to span.*
 *
 * That keeps them free of I/O and of the projection, so they are unit-testable
 * in the coverage-instrumented tier rather than needing a populated tree.
 *
 * 🚨 **A `dstKind` is a CLASS, never an existence verdict.** `out-of-corpus`
 * does not mean "dead": nothing here, and nothing in the projection, stats a
 * path outside the population. See `EdgeDestinationKindSchema` and zones.md §5.
 */

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { EdgeDestinationKind } from '../schemas/projection-edges.js';
import { splitHrefAnchor } from '../utils.js';

/**
 * The four columns of an `edge_resolutions` row that describe its destination.
 *
 * The other six — `src`, `refOrdinal`, `contextId`, `candidateOrdinal`, `tier`
 * and `score` — belong to the edge or to the lens's grading of it, not to the
 * target, so a builder here has nothing to say about them.
 */
export interface EdgeDestination {
  readonly dstKind: EdgeDestinationKind;
  readonly dstKey: string;
  readonly dstResource: string | null;
  readonly dstAnchor: string | null;
}

/**
 * Ports a URI carries only redundantly, so two spellings of one origin key alike.
 *
 * `URL` already drops these itself — this table is the fallback path's copy, and
 * it is small on purpose: a port this map does not know is KEPT, which is the
 * safe direction. Dropping an unknown port would merge two genuinely different
 * origins; keeping a redundant one only splits a group that could have been one.
 */
const DEFAULT_PORTS = new Map([
  ['http:', '80'],
  ['https:', '443'],
  ['ws:', '80'],
  ['wss:', '443'],
  ['ftp:', '21'],
]);

/**
 * A destination the corpus contains.
 *
 * `dstKey` is the resource id, which `identity.ts` already mints as
 * `hash(rootId, canonicalPath)` — opaque, and already the one spelling every
 * realization of that file shares. There is nothing further to normalize, which
 * is what makes this class the cheap one.
 *
 * @param resourceId - The target's `resources.resourceId`
 * @param anchor - Fragment naming a section, or null. Joins `blob_sections.slug`
 *   for this class — and only for this class
 * @returns The destination columns
 */
export function resourceDestination(resourceId: string, anchor: string | null): EdgeDestination {
  return { dstKind: 'resource', dstKey: resourceId, dstResource: resourceId, dstAnchor: anchor };
}

/**
 * A destination the corpus does not contain but that is still a path.
 *
 * Covers both of zones.md §5's non-external classes — a target outside the
 * corpus boundary, and a declared-but-unwritten one — because from the key's
 * point of view they are the same thing: a path no realization holds.
 *
 * ⚠️ **Not case-folded**, deliberately. A case-only rename is a different target
 * on a case-sensitive filesystem, and merging the two would report one file
 * where there are two. ⚠️ **Not stable across extent widening**: widening moves
 * this destination into {@link resourceDestination}'s class, so the key changes
 * *class*, not merely value. That is recorded in the schema rather than
 * engineered away — this branch has no identity service the way the resource
 * branch has `identity.ts`.
 *
 * @param relativePath - The target as a path relative to the corpus root
 * @param anchor - Fragment as authored, or null. Nothing in the projection can
 *   resolve it for this class
 * @returns The destination columns
 */
export function outOfCorpusDestination(relativePath: string, anchor: string | null): EdgeDestination {
  return {
    dstKind: 'out-of-corpus',
    // One-argument `join` normalizes: it collapses `.`/`..` lexically, so
    // `docs/./a/../b.md` and `docs/b.md` are one key. `toForwardSlash` runs
    // FIRST because a backslash is not a separator on POSIX — normalizing a
    // Windows-spelled path before converting it would leave `docs\a\..\b.md`
    // as one opaque segment and produce a key that never matches its own
    // forward-slashed twin. Lexical, not `realpath`: the target is by
    // definition not in the corpus, so there is nothing here entitled to stat.
    dstKey: safePath.join(toForwardSlash(relativePath)),
    dstResource: null,
    dstAnchor: anchor,
  };
}

/**
 * A destination that must never be a resource — projecting it would mean
 * projecting the web.
 *
 * Normalization, which is zones.md §5's ruling made executable:
 *
 * - **scheme and host lowercased** (RFC 3986 §3.2.2 makes both
 *   case-insensitive), and the scheme's **default port dropped**;
 * - **path, query and fragment left exactly as authored** — path case is
 *   significant on any case-sensitive server, so folding it would merge
 *   genuinely distinct targets;
 * - the **fragment removed from the key** and returned as `dstAnchor`, because
 *   it names a location *within* a destination: two links to `#a` and `#b` of
 *   one page cite the same page, and a reverse index that splits them is wrong.
 *   The **query is kept**, because it commonly identifies a distinct resource.
 *
 * ⚠️ **The fallback is honest, not canonical.** A protocol-relative reference
 * (`//host/path`) is external by `closure-extent.ts`'s own `NON_LOCAL_REF` test
 * but has no scheme for `URL` to parse without a base, and inventing one would
 * put a scheme in the key that the author did not write. So an unparseable token
 * is keyed on itself, minus its fragment: two spellings that `URL` would have
 * unified may stay two keys. That under-groups, which is the safe direction —
 * the alternative merges destinations that are not the same.
 *
 * @param rawRef - The reference exactly as authored
 * @returns The destination columns, with `dstResource` always null
 */
export function externalDestination(rawRef: string): EdgeDestination {
  const [withoutFragment] = splitHrefAnchor(rawRef);
  const anchor = fragmentOf(rawRef);
  return {
    dstKind: 'external',
    // Never empty: `splitHrefAnchor('#f')` yields `''`, and a zero-length key
    // would fail the schema's `min(1)`. Falling back to the raw token keeps a
    // degenerate reference expressible rather than unrepresentable.
    dstKey: normalizeUri(withoutFragment) || rawRef,
    dstResource: null,
    dstAnchor: anchor,
  };
}

/**
 * The fragment an authored token carries, or null.
 *
 * Exported because the edge lens needs the same answer for its two
 * *non*-external classes, where the destination is a path rather than a URI:
 * `resolveLocalHref` reports an anchor only on its `resolved` branch, so an
 * out-of-corpus target would otherwise silently lose the section its author
 * named. One definition, so "what fragment did this reference carry" cannot be
 * answered two ways.
 *
 * An empty fragment (`x.md#`) is null rather than `''`: the author named no
 * section, and `''` would make "has an anchor" true for a reference that has
 * none.
 *
 * @param rawRef - The reference exactly as authored
 * @returns The fragment without its `#`, or null when there is none
 */
export function fragmentOf(rawRef: string): string | null {
  const [, anchor] = splitHrefAnchor(rawRef);
  return anchor === undefined || anchor === '' ? null : anchor;
}

/**
 * Apply the scheme/host/port half of the ruling, or give the token back unchanged.
 *
 * Separated from {@link externalDestination} so the fallback is one branch with
 * one reason, rather than a `catch` wrapped around the whole builder — a `catch`
 * that wide would also swallow a genuine defect in the fragment handling.
 *
 * @param withoutFragment - The reference with any `#fragment` already removed
 * @returns The normalized URI, or the input when it does not parse as one
 */
function normalizeUri(withoutFragment: string): string {
  let url: URL;
  try {
    url = new URL(withoutFragment);
  } catch {
    return withoutFragment;
  }
  // `URL` lowercases the scheme and host and drops a default port on
  // construction, and leaves path and query case alone — which is exactly the
  // ruling, so this reads the result rather than re-implementing it. The port
  // check below is belt-and-braces for a scheme `URL` does not treat as
  // special: it keeps `:80` on such a scheme, and so do we.
  const defaultPort = DEFAULT_PORTS.get(url.protocol);
  if (defaultPort !== undefined && url.port === defaultPort) url.port = '';
  return url.href;
}
