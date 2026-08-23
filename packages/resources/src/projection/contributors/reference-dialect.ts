/**
 * How a closure INTERPRETS the reference tokens it follows.
 *
 * A `blob_references` row carries the token *exactly as authored* — that is
 * `blob-references.ts`'s stated contract, and it is what lets `rawRef` be
 * printed back to an author in a condition row. Interpretation is therefore a
 * property of the READER, and different readers genuinely disagree: VAT's own
 * link validation reads an href under RFC 3986, and Claude Code reads an
 * `@`-token under a vendor dialect in which three of those rules are different.
 *
 * ## Why a declared dialect, and not either of the two alternatives
 *
 * ⛔ **Not a strip in the lexer.** `rawRef` is documented as the reference
 * exactly as authored; rewriting it would change the parse-fact shape,
 * invalidate every adopter's parse cache, and make `blob-references.ts`'s
 * `leadingAt` column constant-false. Decisively: **`@` is not always an
 * import.** `@vibe-agent-toolkit/utils` is an npm scope, and a global strip
 * turns it into a path that can resolve against a real directory and be charged
 * as loaded context — a new false positive in the inflating direction.
 *
 * ⛔ **Not a mode inside {@link resolveLocalHref}.** That is VAT's general RFC
 * 3986 resolver, shared with link validation and audit. A vendor dialect living
 * inside it is the same boundary violation as filing a Claude-specific analysis
 * verb under `vat resources`.
 *
 * So the dialect rides on the DECLARATION. It stays inert data, which means it
 * travels onto `zone_provenance.parameterSet` verbatim and the projection
 * store's reuse key correctly treats two runs over one tree under different
 * dialects as two different questions.
 *
 * The vocabulary itself — `ReferenceDialectSchema` — lives in
 * `schemas/project-config.ts` beside the declaration that carries it, not here.
 * A schema importing a contributor would invert the layering every other
 * contributor in this directory observes.
 *
 * ## The dialect DELEGATES; it does not reimplement
 *
 * `CLAUDE.md` forbids a parallel path-only resolver, and the ordinary case — a
 * relative token resolved against the importing file's directory — is
 * {@link resolveLocalHref}'s, unchanged, called here. The two branches that do
 * NOT delegate are the two where the vendor's rule and RFC 3986's rule are
 * different answers to the same input, so there is no shared resolution to
 * reuse:
 *
 * | Token | RFC 3986 (`href`) | Claude Code (`claude-import`) |
 * |---|---|---|
 * | `@b.md` | a file literally named `@b.md` | `b.md` |
 * | `/x/y.md` | root-relative — resolves INSIDE the corpus | filesystem-absolute |
 * | `~/x.md` | a directory literally named `~` | the user's home directory |
 *
 * ## 🪤 Three consequences worth naming rather than rediscovering
 *
 * - **`@scope/pkg` resolves as a relative path and lands
 *   `CLOSURE_REFERENCE_UNRESOLVED`.** Accepted, and it is NOT the false positive
 *   the lexer-strip alternative was rejected for: under a *declared* dialect the
 *   strip is reachable only from a `CLAUDE.md` or rules-file root, where an
 *   `@`-token is an import by the vendor's own definition. That scoping is
 *   exactly what a lexer-level strip could not have had.
 * - **`@${VAR}/path.md` never reaches here.** The lexer classifies a token
 *   carrying a variable expansion as `env-anchored` whatever else it looks like
 *   (`reference-lexer.ts`'s `classify`), so a declaration following only
 *   `at-prefixed` does not select it. Probably desirable — an unexpanded
 *   variable cannot be resolved — but it is silent, so it is stated.
 * - **{@link homedir} makes `~/` resolution environment-dependent.** Two runs
 *   under different `HOME` values resolve the same token to different paths. The
 *   dialect is in the store's reuse key; `HOME` is not. A `~/` import is
 *   reported `CLOSURE_REFERENCE_OUTSIDE_ROOT` and never charged, so the
 *   divergence cannot change a token count — but it can change a reported
 *   target path, which is why it is recorded here and not left to be found.
 */

import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { ReferenceDialect } from '../../schemas/project-config.js';
import { resolveLocalHref, splitHrefAnchor, type ResolveLocalHrefResult } from '../../utils.js';

/** The token prefix that marks a Claude Code import. */
const IMPORT_PREFIX = '@';

/** The prefix the vendor documents for a home-directory import. */
const HOME_PREFIX = '~/';

/** The prefix the vendor reads as filesystem-absolute and RFC 3986 reads as root-relative. */
const ABSOLUTE_PREFIX = '/';

/**
 * Resolve one reference token under a declared dialect.
 *
 * @param dialect - The declaration's {@link ReferenceDialect}
 * @param rawRef - The reference exactly as authored, `@` and all
 * @param sourceFilePath - Absolute path of the file holding the reference
 * @param projectRoot - Absolute corpus root, for the `href` root-relative branch
 * @returns The same discriminated union {@link resolveLocalHref} returns, so
 *   every caller keeps ONE resolution outcome type and no branch of the closure
 *   has to learn a second shape
 */
export function resolveDialectRef(
  dialect: ReferenceDialect,
  rawRef: string,
  sourceFilePath: string,
  projectRoot: string,
): ResolveLocalHrefResult {
  if (dialect === 'href') return resolveLocalHref(rawRef, sourceFilePath, projectRoot);
  return resolveClaudeImport(rawRef, sourceFilePath, projectRoot);
}

/**
 * The `claude-import` dialect's three rules.
 *
 * Exactly ONE `@` is stripped: a file genuinely named `@notes.md` is imported as
 * `@@notes.md`, and a greedy strip would make it unreachable.
 *
 * A token that is nothing but `@` becomes the empty href, which
 * {@link resolveLocalHref} reads as `anchor_only`. Answering that directly is
 * what stops a stray `@` in prose from resolving to the containing DIRECTORY and
 * pulling it into the extent.
 *
 * @param rawRef - The reference exactly as authored
 * @param sourceFilePath - Absolute path of the file holding the reference
 * @param projectRoot - Absolute corpus root
 * @returns The resolution outcome
 */
function resolveClaudeImport(
  rawRef: string,
  sourceFilePath: string,
  projectRoot: string,
): ResolveLocalHrefResult {
  // Named `unprefixed` rather than `token`: `security/detect-possible-timing-attacks`
  // reads an identifier called `token` as a secret and flags the emptiness test
  // below as a timing leak. It is a lexer token, not a credential.
  const unprefixed = rawRef.startsWith(IMPORT_PREFIX)
    ? rawRef.slice(IMPORT_PREFIX.length)
    : rawRef;
  if (unprefixed === '') return { kind: 'anchor_only' };

  if (unprefixed.startsWith(HOME_PREFIX)) {
    const [fileHref, anchor] = splitHrefAnchor(unprefixed);
    return {
      kind: 'resolved',
      resolvedPath: safePath.join(homedir(), fileHref.slice(HOME_PREFIX.length)),
      anchor,
    };
  }

  if (unprefixed.startsWith(ABSOLUTE_PREFIX)) {
    const [fileHref, anchor] = splitHrefAnchor(unprefixed);
    return { kind: 'resolved', resolvedPath: safePath.resolve(fileHref), anchor };
  }

  // The ordinary case, and the overwhelming majority of every real corpus: a
  // token resolved against the importing file's directory, which is
  // `resolveLocalHref`'s own rule and is CALLED rather than restated.
  return resolveLocalHref(unprefixed, sourceFilePath, projectRoot);
}
