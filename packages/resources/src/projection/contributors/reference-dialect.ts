/**
 * How a closure INTERPRETS the edges it follows.
 *
 * Two readers genuinely disagree about what a reference means. VAT's own link
 * validation reads a `blob_references` token as an href under RFC 3986; Claude
 * Code reads an `@` import — a `harness_blob_imports` row, produced by the
 * harness's own extractor — the way its `et` resolves a path. The dialect names
 * the reader, and the closure picks the edge table from it
 * (`closure-extent.ts`'s `edgeSourceFor`), so one field decides both what an
 * edge IS and what it points at.
 *
 * ## Why a declared dialect
 *
 * `@` is not always an import: `@vibe-agent-toolkit/utils` is an npm scope. A
 * global reading would turn it into a path that can resolve against a real
 * directory. The dialect rides on the DECLARATION instead, which is inert data:
 * it travels onto `zone_provenance.parameterSet` verbatim, and the projection
 * store's reuse key treats two runs over one tree under different dialects as
 * two different questions.
 *
 * The vocabulary itself — `ReferenceDialectSchema` — lives in
 * `schemas/project-config.ts` beside the declaration that carries it, not here.
 * A schema importing a contributor would invert the layering every other
 * contributor in this directory observes.
 *
 * ## The two readings
 *
 * | Edge | `href` (a `blob_references.rawRef`) | `claude-import` (a `harness_blob_imports.target`) |
 * |---|---|---|
 * | `b.md` | relative, percent-decoded | relative, taken literally |
 * | `/x/y.md` | root-relative — resolves INSIDE the corpus | filesystem-absolute |
 * | `~/x.md` | a directory literally named `~` | the user's home directory |
 *
 * `href` is {@link resolveLocalHref}, unchanged. `claude-import` is now the
 * declared dialect's own {@link HarnessProfile.resolveImport} — the binary's
 * `et` (trim; `~` and `~/` expand; an absolute path stays; anything else is
 * `path.resolve`d against the importing file's directory), transcribed in
 * `docs/external/claude-code-memory-loader.md` and held by `harness/claude-code.ts`
 * rather than by this module. It does not delegate to {@link resolveLocalHref}
 * because no branch of that resolver is `et`'s: the harness percent-decodes
 * nothing and treats a leading `/` as absolute. The `@`, the `#` fragment and
 * the `\ ` escape were already dealt with by the extractor that produced the
 * row, so none of them reaches it.
 *
 * @vendor-claim reviewed=2026-09-23 verify=Re-extract `et` from the current Claude Code binary per docs/external/claude-code-memory-loader.md and diff it against harness/claude-code.ts's resolveClaudeImport
 */

import type { ReferenceDialect } from '../../schemas/project-config.js';
import { resolveLocalHref, type ResolveLocalHrefResult } from '../../utils.js';
import { harnessForDialect } from '../harness/profile.js';

/**
 * Resolve one edge under a declared dialect.
 *
 * @param dialect - The declaration's {@link ReferenceDialect}
 * @param token - A `blob_references.rawRef` under `href`, a
 *   `harness_blob_imports.target` under `claude-import`
 * @param sourceFilePath - Absolute path of the file holding the reference
 * @param projectRoot - Absolute corpus root, for the `href` root-relative branch
 * @returns The same discriminated union {@link resolveLocalHref} returns, so
 *   every caller keeps ONE resolution outcome type and no branch of the closure
 *   has to learn a second shape
 */
export function resolveDialectRef(
  dialect: ReferenceDialect,
  token: string,
  sourceFilePath: string,
  projectRoot: string,
): ResolveLocalHrefResult {
  if (dialect === 'href') return resolveLocalHref(token, sourceFilePath, projectRoot);
  return harnessForDialect(dialect).resolveImport(token, sourceFilePath);
}
