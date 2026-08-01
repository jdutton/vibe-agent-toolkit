/**
 * Public rewriter helpers built on FrontmatterEditor and shared callback
 * shape `(href: string) => string`.
 *
 * Three layers:
 *   1. rewriteFrontmatterUriReferencesFromSchema — schema-driven; used by
 *      VAT packager and by schema-aware adopter scripts.
 *   2. rewriteFrontmatterFieldsAtPaths — path-driven; used by ad-hoc
 *      adopter scripts (no JSON Schema available; field paths known by
 *      convention).
 *   3. rewriteBodyLinks — standalone body-side counterpart. Parallel to
 *      `transformContent` but with a callback model instead of templates.
 *
 * All three inherit {@link FrontmatterEditor}'s round-trip identity contract:
 * a rewrite that changes no href must leave the document byte-identical.
 */

import { isNode } from 'yaml';

import type { FrontmatterEditor } from './frontmatter-editor.js';
import { jsonPointerToPath } from './json-pointer-path.js';
import { walkFrontmatterUriReferences } from './schema-uri-walker.js';

/**
 * Normalize a value returned by `FrontmatterEditor.get(path)` into plain JS.
 *
 * The underlying yaml library's `getIn(path, false)` unwraps scalar leaves to
 * JS primitives but leaves YAMLMap / YAMLSeq collections as Node instances.
 * The rewriter helpers reason in terms of JS values (arrays, strings), so we
 * unwrap collection Nodes here once at the boundary.
 */
function toPlainJs(value: unknown): unknown {
  if (isNode(value)) return value.toJSON();
  return value;
}

/** Type for the rewrite policy callback — same shape for body and frontmatter. */
export type RewriteHref = (href: string) => string;

/**
 * Apply `rewriteHref` to every frontmatter scalar whose schema position has
 * a URI-family `format`. Preserves comments via FrontmatterEditor.
 */
export function rewriteFrontmatterUriReferencesFromSchema(
  editor: FrontmatterEditor,
  schema: object,
  rewriteHref: RewriteHref,
): void {
  const frontmatter = editor.get([]);
  if (frontmatter === undefined || frontmatter === null) return;
  if (typeof frontmatter !== 'object') return;

  const captures = walkFrontmatterUriReferences(frontmatter, schema);
  for (const capture of captures) {
    const path = jsonPointerToPath(capture.pointer);
    if (path.length === 0) continue;
    const newValue = rewriteHref(capture.value);
    if (newValue === capture.value) continue;
    const lastSegment = path.at(-1);
    if (typeof lastSegment === 'number') {
      const parentPath = path.slice(0, -1);
      editor.setArrayItem(parentPath, lastSegment, newValue);
    } else {
      editor.set(path, newValue);
    }
  }
}

interface ParsedPath {
  segments: readonly (string | number)[];
  isArray: boolean;
}

function parsePathPattern(pattern: string): ParsedPath {
  const isArray = pattern.endsWith('[]');
  const cleaned = isArray ? pattern.slice(0, -2) : pattern;
  const segments = cleaned.split('.');
  return { segments, isArray };
}

function rewriteArrayPath(
  editor: FrontmatterEditor,
  segments: readonly (string | number)[],
  value: unknown,
  rewriteHref: RewriteHref,
): void {
  if (!Array.isArray(value)) return;
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string') continue;
    const newValue = rewriteHref(item);
    if (newValue !== item) editor.setArrayItem(segments, i, newValue);
  }
}

function rewriteScalarPath(
  editor: FrontmatterEditor,
  segments: readonly (string | number)[],
  value: unknown,
  rewriteHref: RewriteHref,
): void {
  if (typeof value !== 'string') return;
  const newValue = rewriteHref(value);
  if (newValue !== value) editor.set(segments, newValue);
}

/**
 * Apply `rewriteHref` to specific frontmatter fields named by explicit
 * dotted paths. Used by adopter scripts that know which fields hold
 * references without a JSON Schema.
 *
 * Path syntax:
 *   - 'name'            — top-level scalar
 *   - 'name[]'          — array of strings (rewrite each string item)
 *   - 'meta.parent'     — dotted nested scalar
 *   - 'meta.refs[]'     — dotted nested array of strings
 *
 * Missing paths are silent no-ops. Non-string values are skipped.
 */
export function rewriteFrontmatterFieldsAtPaths(
  editor: FrontmatterEditor,
  paths: readonly string[],
  rewriteHref: RewriteHref,
): void {
  for (const pattern of paths) {
    const { segments, isArray } = parsePathPattern(pattern);
    const value = toPlainJs(editor.get(segments));
    if (value === undefined || value === null) continue;
    if (isArray) {
      rewriteArrayPath(editor, segments, value, rewriteHref);
    } else {
      rewriteScalarPath(editor, segments, value, rewriteHref);
    }
  }
}

/**
 * Inline + reference-style link patterns. These match `transformContent`'s
 * regex contract — see content-transform.ts for the rationale on negated
 * character classes.
 */
// eslint-disable-next-line sonarjs/slow-regex -- negated character classes [^\]] and [^)] are non-backtracking
const INLINE_LINK_REGEX = /\[([^\]]*)\]\(([^)]*)\)/g;
// eslint-disable-next-line sonarjs/slow-regex -- Controlled markdown reference link definitions on line boundaries
const DEFINITION_LINK_REGEX = /^\[([^\]]*?)\]:\s*(.+)$/gm;

/**
 * Apply `rewriteHref` to every inline-link and reference-definition href in
 * a markdown body. Parallel to `transformContent` but with a callback model
 * — appropriate for adopter scripts and for any caller that wants a
 * per-href rewrite without rule/template ceremony.
 *
 * `rewriteHref` receives the raw href (including any fragment) and returns
 * the new href. Returning the same string is a no-op for that link.
 */
export function rewriteBodyLinks(body: string, rewriteHref: RewriteHref): string {
  let out = body.replaceAll(INLINE_LINK_REGEX, (full, text: string, href: string) => {
    const next = rewriteHref(href);
    return next === href ? full : `[${text}](${next})`;
  });
  out = out.replaceAll(DEFINITION_LINK_REGEX, (full, ref: string, href: string) => {
    const trimmed = href.trim();
    const next = rewriteHref(trimmed);
    return next === trimmed ? full : `[${ref}]: ${next}`;
  });
  return out;
}
