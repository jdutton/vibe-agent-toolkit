/**
 * How a closure INTERPRETS the edges it follows.
 *
 * Two readers genuinely disagree about what a reference means. VAT's own link
 * validation reads a `blob_references` token as an href under RFC 3986; Claude
 * Code reads an `@` import — a `blob_claude_imports` row, produced by the
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
 * | Edge | `href` (a `blob_references.rawRef`) | `claude-import` (a `blob_claude_imports.target`) |
 * |---|---|---|
 * | `b.md` | relative, percent-decoded | relative, taken literally |
 * | `/x/y.md` | root-relative — resolves INSIDE the corpus | filesystem-absolute |
 * | `~/x.md` | a directory literally named `~` | the user's home directory |
 *
 * `href` is {@link resolveLocalHref}, unchanged. `claude-import` is the binary's
 * `et` (trim; `~` and `~/` expand; an absolute path stays; anything else is
 * `path.resolve`d against the importing file's directory) — transcribed in
 * `docs/external/claude-code-memory-loader.md`. It does not delegate to
 * {@link resolveLocalHref} because no branch of that resolver is `et`'s: the
 * harness percent-decodes nothing and treats a leading `/` as absolute. The
 * `@`, the `#` fragment and the `\ ` escape were already dealt with by the
 * extractor that produced the row, so none of them reaches this function.
 *
 * ## 🪤 {@link homedir} makes `~/` resolution environment-dependent
 *
 * Two runs under different `HOME` values resolve the same token to different
 * paths. The dialect is in the store's reuse key; `HOME` is not. A `~/` import
 * is reported `CLOSURE_REFERENCE_OUTSIDE_ROOT` and never charged, so the
 * divergence cannot change a token count — but it can change a reported target
 * path, which is why it is recorded here and not left to be found.
 *
 * @vendor-claim reviewed=2026-09-23 verify=Re-extract `et` from the current Claude Code binary per docs/external/claude-code-memory-loader.md and diff it against resolveClaudeImport
 */

import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { ReferenceDialect } from '../../schemas/project-config.js';
import { resolveLocalHref, type ResolveLocalHrefResult } from '../../utils.js';

/** The token `et` expands to the home directory, alone or as a `~/` prefix. */
const HOME = '~';

/** The prefix the harness reads as filesystem-absolute and RFC 3986 reads as root-relative. */
const ABSOLUTE_PREFIX = '/';

/**
 * Resolve one edge under a declared dialect.
 *
 * @param dialect - The declaration's {@link ReferenceDialect}
 * @param token - A `blob_references.rawRef` under `href`, a
 *   `blob_claude_imports.target` under `claude-import`
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
  return resolveClaudeImport(token, sourceFilePath);
}

/**
 * `et` — the harness's own resolution of one import target.
 *
 * An empty target (only whitespace survived the trim) names no file: `et`
 * answers the importing directory, which the reader skips as not a regular
 * file, so `anchor_only` keeps a directory out of the extent.
 *
 * @param target - A `blob_claude_imports.target`
 * @param sourceFilePath - Absolute path of the importing file
 * @returns The resolution outcome
 */
function resolveClaudeImport(target: string, sourceFilePath: string): ResolveLocalHrefResult {
  const trimmed = target.trim();
  if (trimmed === '') return { kind: 'anchor_only' };
  if (trimmed === HOME) return resolvedAt(homedir());
  if (trimmed.startsWith(`${HOME}/`)) return resolvedAt(safePath.join(homedir(), trimmed.slice(HOME.length + 1)));
  if (trimmed.startsWith(ABSOLUTE_PREFIX)) return resolvedAt(safePath.resolve(trimmed));
  return resolvedAt(safePath.resolve(dirname(sourceFilePath), trimmed));
}

/**
 * A resolved outcome with no fragment — the extractor already cut it.
 *
 * @param resolvedPath - The absolute target
 * @returns The outcome
 */
function resolvedAt(resolvedPath: string): ResolveLocalHrefResult {
  return { kind: 'resolved', resolvedPath, anchor: undefined };
}
