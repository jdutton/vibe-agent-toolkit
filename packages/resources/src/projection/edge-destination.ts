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
/** An RFC 3986 scheme, matched against an already-isolated prefix. */
const SCHEME = /^[a-z][\w+.-]*$/iu;

/**
 * Where the authority begins, or -1 when the token has no authority at all.
 *
 * The scheme is accepted as well as absent, not merely the protocol-relative
 * `//`: `new URL` throws on a fully-spelled URL with an out-of-range port
 * (measured: `ERR_INVALID_URL` on `https://user:pw@example.com:99999/x`), so a
 * credentialled https token really does reach the fallback. A `//`-only test
 * would redact the protocol-relative shape while publishing that one — the same
 * half-fix, one level down.
 *
 * The scheme is verified against {@link SCHEME} rather than trusting the first
 * `://` found anywhere, so a `://` inside a query (`mailto:x?u=http://a@b/c`)
 * does not open an authority two thirds of the way through a token.
 *
 * @param token - The reference with any fragment already removed
 * @returns Index of the first character after `//`, or -1
 */
function authorityStartOf(token: string): number {
  if (token.startsWith('//')) return 2;
  const schemeEnd = token.indexOf('://');
  return schemeEnd > 0 && SCHEME.test(token.slice(0, schemeEnd)) ? schemeEnd + 3 : -1;
}

/**
 * Delete the `user:pw@` half of an authority, leaving every other byte in place.
 *
 * ## Why this is a string scan and not a regex
 *
 * `/^((?:[a-z][\w+.-]*:)?\/\/)[^/]*@/` expresses the same rule and is what this
 * started as. `security/detect-unsafe-regex` refuses it — a starred group inside
 * an optional group reads as star height 2 to safe-regex's heuristic — and this
 * repository's answer to a linter smell is to remove it, not to argue it away.
 * ⚠️ The rewrite is only worth anything if it is ACTUALLY linear, which a regex
 * rewrite that merely satisfies the checker often is not: this one is two
 * `indexOf`/`lastIndexOf` scans and one bounded `test`, with no backtracking
 * anywhere.
 *
 * It also states the two boundary rules instead of implying them:
 *
 * - `lastIndexOf('@', ...)` **is** "the last `@` wins", where the regex got the
 *   same answer only as a side effect of greedy backtracking. `//a@b@host/x`
 *   redacts to `//host/x`; the near-miss `//b@host/x` still LOOKS redacted while
 *   carrying a credential, which is why a test pins it.
 * - The search stops at the first `/` after the authority, so an `@` in a PATH
 *   (`//host/path@thing`) is not userinfo and survives untouched.
 *
 * @param token - The reference with any fragment already removed
 * @returns The token with any authority userinfo removed
 */
function redactAuthorityUserinfo(token: string): string {
  const authorityStart = authorityStartOf(token);
  if (authorityStart === -1) return token;
  const pathStart = token.indexOf('/', authorityStart);
  const authorityEnd = pathStart === -1 ? token.length : pathStart;
  const at = token.lastIndexOf('@', authorityEnd - 1);
  return at < authorityStart ? token : token.slice(0, authorityStart) + token.slice(at + 1);
}

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
  assertNonEmpty(resourceId, 'resourceDestination', 'a resource id');
  assertNamedAnchor(anchor, 'resourceDestination');
  return { dstKind: 'resource', dstKey: resourceId, dstResource: resourceId, dstAnchor: anchor };
}

/**
 * Refuse a value that cannot denote a destination.
 *
 * ## 🚨 Why these builders THROW, and why that is not a hazard on user data
 *
 * This module claims the three rulings are *unconstructible*, not merely
 * validated — "the difference between a producer that fails validation and a
 * producer that cannot express the mistake". That claim was FALSE:
 * `resourceDestination('')` and `externalDestination('')` both returned
 * `dstKey: ''`, which the shipped schema then rejects. Validation was still the
 * last line of defence, exactly as the docstring said it no longer was.
 *
 * ⚠️ **These two assertions are reachable only from a PROGRAMMING error, and
 * that is a narrower claim than it first looks — a third assertion written
 * beside them was NOT, and it crashed the command on valid markdown.**
 * `resourceId` is minted by `identity.ts`, and the external branch is reached
 * only when `NON_LOCAL_REF` matched, which requires a scheme or `//`; an empty
 * string satisfies neither, so neither `assertNonEmpty` call can fire on
 * author-written input. `assertNamedAnchor` is likewise unreachable: every
 * production caller passes `fragmentOf()`, which returns null and never `''`.
 *
 * 🚨 The refusal that DID fire is the cautionary case, and it is why the
 * paragraph above is stated per-assertion rather than as a blanket property of
 * the module. It rejected a path containing `#`, reasoning that the caller
 * splits the fragment off beforehand — true, but the split happens BEFORE
 * percent-decoding, so a file named `release#notes.md`, linked as
 * `./release%23notes.md`, reaches the builder with a `#` that was never a
 * fragment. `vat resources query` exited 2 on it. See
 * {@link outOfCorpusDestination}.
 *
 * ⇒ Before adding a refusal here, name the decoding step your reachability
 * argument depends on. "The caller already handled it" is not an argument
 * until you have said WHERE, and checked that nothing downstream re-creates
 * the character the caller removed.
 *
 * @param value - The candidate key
 * @param builder - Which builder is refusing, for the message
 * @param what - What the value was supposed to be
 * @throws TypeError When the value is empty
 */
function assertNonEmpty(value: string, builder: string, what: string): void {
  if (value.length > 0) return;
  throw new TypeError(
    `${builder}() was given an empty string where it needs ${what}. A destination must have a`
    + ' non-empty `dstKey` — it is the grouping key every reverse-index query joins on — and an'
    + ' empty one fails `EdgeResolutionRowSchema`. This is a programming error: every caller'
    + ' supplies a value the projection minted, never raw document text.',
  );
}

/**
 * Refuse an anchor that is present but names nothing.
 *
 * `null` is "no fragment" and is the only correct spelling of it. `''` would
 * make "has an anchor" true for a reference that has none — the rule
 * {@link fragmentOf} already applies, and which the builders accepted as a bare
 * parameter and so did not enforce.
 *
 * @param anchor - The anchor to check
 * @param builder - Which builder is refusing, for the message
 * @throws TypeError When the anchor is an empty string
 */
function assertNamedAnchor(anchor: string | null, builder: string): void {
  if (anchor !== '') return;
  throw new TypeError(
    `${builder}() was given an empty anchor. Use null for "no fragment": an empty string makes`
    + ' "has an anchor" true for a reference that names no section. `fragmentOf()` already'
    + ' returns null for `x.md#`, so pass its result through unchanged.',
  );
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
  assertNamedAnchor(anchor, 'outOfCorpusDestination');
  // 🚨 A `#` in this path is a FILENAME CHARACTER, not an unsplit fragment, and
  // a guard that refused it CRASHED the command on valid markdown.
  //
  // The refusal read: "the caller already separates the two halves, so a `#`
  // here means the caller stopped doing that". The premise is false, because
  // the two halves are separated at a point where the character cannot yet be
  // told apart. `splitHrefAnchor` cuts the RAW href at its first `#`, and only
  // then does `resolveLocalHref` percent-DECODE what is left
  // (`utils.ts:152`). So `[t](./release%23notes.md)` — the RFC 3986-correct
  // spelling of a file literally named `release#notes.md`, and `#` is a legal
  // POSIX filename character — arrives here as `release#notes.md` with a null
  // anchor. Nothing was left unsplit; the fragment delimiter and the literal
  // are simply the same byte after decoding.
  //
  // Measured: with the target absent, `vat resources query` exited 2 on a
  // two-file corpus whose only link was that one. It fires once per extent, so
  // a single such link anywhere in a tree could take the whole command down.
  //
  // ⇒ Key it as-is. That splits nothing: `release#notes.md` is ONE destination,
  // and the `#a`-versus-`#b` grouping error the external branch guards against
  // needs an anchor, which this class receives separately and never folds in.
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
 * - **userinfo removed** — `dstKey` is printed verbatim by `vat resources
 *   query`, so a `user:pw@` half retained here is a credential republished into
 *   a CI log. It is also not part of the destination's identity: two links to
 *   one origin, one credentialled and one not, cite the same page;
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
 * ⭐ **Userinfo is redacted on that branch too, and that is not a
 * canonicalization.** "Honest, not canonical" is a refusal to assert an
 * EQUIVALENCE the parser did not establish; deleting a credential asserts
 * nothing and invents nothing. Both branches redact, so "this key carries no
 * secret" is a property of the function rather than of which branch an input
 * happened to take — a half-redacting function is worse than a non-redacting
 * one, because its output reads as safe.
 *
 * @param rawRef - The reference exactly as authored
 * @returns The destination columns, with `dstResource` always null
 */
export function externalDestination(rawRef: string): EdgeDestination {
  const [withoutFragment] = splitHrefAnchor(rawRef);
  const anchor = fragmentOf(rawRef);
  // ⚠️ The fallback covers `'#f'`, whose fragment-free half is `''` — it keys on
  // `'#f'`. A bare `'#'` likewise keys on `'#'`, which is non-empty and gets the
  // same treatment. The ONLY input the fallback cannot rescue is a rawRef that
  // is itself empty, which yields `''` and fails the schema's `min(1)`: a
  // reference that names nothing has no destination, so it is refused rather
  // than keyed on emptiness. (An earlier version of this comment claimed `'#'`
  // produced `''` too; it does not, and the test three lines from here says so.)
  //
  // ⚠️ Consequently this assertion is UNREACHABLE from production: the only
  // caller gates on `NON_LOCAL_REF`, which no empty string matches. It stays as
  // a guard on a future caller, not as a live check — do not cite it as
  // evidence that the empty-key hole is closed at runtime.
  const key = normalizeUri(withoutFragment) || rawRef;
  assertNonEmpty(key, 'externalDestination', 'a reference that names something');
  return {
    dstKind: 'external',
    dstKey: key,
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
    // ⭐ The ONE mutation this branch makes, and it is deliberate: REDACTION,
    // not canonicalization. The two are different acts and only the second is
    // what "honest, not canonical" refuses. Canonicalizing asserts an
    // EQUIVALENCE — that two spellings are one destination — and can be wrong,
    // which is why this branch will not invent a scheme or fold a host. Deleting
    // a credential asserts nothing: it removes bytes that were never part of the
    // destination's identity, and that this column would otherwise republish
    // verbatim into a CI log (`dstKey` is printed as plain YAML by
    // `vat resources query`).
    //
    // 🚨 It is here because the success branch's `url.username = ''` alone was a
    // HALF-fix, which is worse than none: the redacted half reads as the whole,
    // so a credential surviving in a token `URL` refused would be trusted as
    // absent. See {@link redactAuthorityUserinfo} for exactly what it removes.
    return redactAuthorityUserinfo(withoutFragment);
  }
  // `URL` lowercases the scheme and host and drops a default port on
  // construction, and leaves path and query case alone — which is exactly the
  // ruling, so this reads the result rather than re-implementing it. The port
  // check below is belt-and-braces for a scheme `URL` does not treat as
  // special: it keeps `:80` on such a scheme, and so do we.
  const defaultPort = DEFAULT_PORTS.get(url.protocol);
  if (defaultPort !== undefined && url.port === defaultPort) url.port = '';
  // 🚨 `href` RETAINS userinfo, and `dstKey` is a PUBLISHED column — `vat
  // resources query` prints it as plain YAML, so `https://user:pw@host/a` put
  // the credential straight into a CI log. Cleared here, beside the port, for
  // the same reason the port is: this is where the parsed URL is edited into
  // the key. Clearing both halves is a no-op on a URI that carries neither, and
  // on a scheme whose URLs cannot hold them at all (`mailto:`), so the branch
  // needs no guard.
  //
  // ⚠️ Success branch ONLY. The fallback above returns the token untouched, so
  // a credential in a protocol-relative reference is still keyed — parsing that
  // would require inventing a scheme the author did not write, which is the
  // trade the fallback's docstring already refuses.
  url.username = '';
  url.password = '';
  return url.href;
}
