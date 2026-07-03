/**
 * Byte-surgical YAML value updater.
 *
 * The motivating problem: editing one value in an adopter's config file with the
 * naive `doc.setIn(...); doc.toString()` round-trip reflows the ENTIRE document —
 * collapsing flow sequences, re-wrapping long scalars, shifting comment alignment,
 * normalising quote styles. That destroys hand-authored formatting the user never
 * asked us to touch.
 *
 * This module instead changes the **minimum bytes possible**:
 *
 * - **Replace** an existing scalar: locate its source byte range via the parsed
 *   node and splice the new serialized token in place. Every other byte is
 *   identical.
 * - **Insert** a new key: render ONLY the new nested fragment, indent it to the
 *   target map's child column, and splice it in after the map's last item. The
 *   rest of the document is never re-rendered.
 *
 * `verifyConfinedYamlEdit` is the double-checker: it re-parses before/after and
 * asserts the edit landed, no other leaf value drifted, and no comment was lost.
 * `updateYamlIn` calls it internally as a defensive post-condition.
 *
 * No filesystem access — these are pure string transforms.
 */

import {
  Document,
  isCollection,
  isMap,
  isScalar,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type YAMLMap,
} from 'yaml';

/** A path into a YAML document: map keys (strings) and/or sequence indices. */
export type YamlPath = (string | number)[];

/** A scalar value this module knows how to serialize as a single YAML token. */
export type YamlScalarValue = string | number | boolean | null;

/** yaml's `toString` options — `lineWidth: 0` disables line-wrapping/folding. */
const NO_WRAP = { lineWidth: 0 } as const;

/**
 * Upsert a single scalar at `path` in `text`, changing the minimum bytes possible.
 *
 * - If `path` already resolves to a scalar, its source token is replaced in place
 *   (byte-identical output except the one value, including surrounding comments,
 *   alignment whitespace, flow-collection padding, and sibling formatting).
 * - If `path` does not yet exist, a new nested fragment is rendered and spliced
 *   into the deepest existing ancestor map at the correct child indentation —
 *   without re-rendering (and thus reflowing) the rest of the document.
 *
 * The input's EOL style (`\n` vs `\r\n`) is detected and preserved.
 *
 * @param text - The full YAML source document.
 * @param path - Key/index path to the scalar to set.
 * @param value - The scalar value to write (string, number, boolean, or null).
 * @returns The updated document text.
 * @throws If `text` is not valid YAML, if `path` is empty, or if `path` resolves
 *   to a collection that would be clobbered by a scalar (or an intermediate
 *   ancestor is a scalar that cannot hold a child).
 *
 * @example
 * updateYamlIn('model: haiku   # note\n', ['model'], 'opus')
 * // => 'model: opus   # note\n'   (alignment + comment preserved)
 */
export function updateYamlIn(text: string, path: YamlPath, value: YamlScalarValue): string {
  if (path.length === 0) {
    throw new Error('updateYamlIn: path must have at least one segment');
  }

  const eol = detectEol(text);
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(`updateYamlIn: input is not valid YAML: ${doc.errors[0]?.message ?? 'unknown'}`);
  }

  const existing = doc.getIn(path, true);

  let result: string;
  if (isScalar(existing)) {
    result = replaceScalarToken(text, existing.range, value, eol);
  } else if (isCollection(existing)) {
    throw new Error(
      `updateYamlIn: refusing to overwrite the collection at [${path.join(', ')}] with a scalar`,
    );
  } else {
    result = insertNewKey(text, doc, path, value, eol);
  }

  // Defensive post-condition: prove the edit was actually confined.
  verifyConfinedYamlEdit(text, result, [path]);
  return result;
}

/**
 * Re-parse `before` and `after` and assert the edit was correct and confined:
 *
 * 1. **Correctness** — every entry in `changedPaths` resolves in `after`.
 * 2. **Confinement** — every other leaf path present in `before` has a deep-equal
 *    value in `after` (no collateral value edits).
 * 3. **Comment preservation** — the multiset of all comment strings is unchanged.
 *
 * Safe to call as an internal assertion from {@link updateYamlIn}.
 *
 * @param before - The original document text.
 * @param after - The edited document text.
 * @param changedPaths - The paths the caller intended to change.
 * @throws A descriptive `Error` naming the offending path or lost comment on any
 *   violation.
 */
export function verifyConfinedYamlEdit(
  before: string,
  after: string,
  changedPaths: YamlPath[],
): void {
  const beforeDoc = parseDocument(before, { prettyErrors: true });
  const afterDoc = parseDocument(after, { prettyErrors: true });
  if (afterDoc.errors.length > 0) {
    throw new Error(
      `verifyConfinedYamlEdit: 'after' is not valid YAML: ${afterDoc.errors[0]?.message ?? 'unknown'}`,
    );
  }

  assertChangedPathsLanded(afterDoc, changedPaths);
  assertConfinement(beforeDoc, afterDoc, changedPaths);
  assertCommentsPreserved(beforeDoc, afterDoc);
}

// ---------------------------------------------------------------------------
// Replace path
// ---------------------------------------------------------------------------

/** Splice a freshly serialized scalar token over the source range `[start, valueEnd]`. */
function replaceScalarToken(
  text: string,
  range: readonly [number, number, number] | null | undefined,
  value: YamlScalarValue,
  eol: string,
): string {
  if (range == null) {
    throw new Error('updateYamlIn: target scalar has no source range (cannot locate it to replace)');
  }
  const [start, valueEnd] = range;
  return text.slice(0, start) + serializeScalar(value, eol) + text.slice(valueEnd);
}

/** Render a value as a single bare YAML token (no key, no trailing newline). */
function serializeScalar(value: YamlScalarValue, eol: string): string {
  const token = new Document(value).toString(NO_WRAP).trimEnd();
  return applyEol(token, eol);
}

// ---------------------------------------------------------------------------
// Insert path
// ---------------------------------------------------------------------------

/** Insert a not-yet-existing key by rendering only the new nested fragment. */
function insertNewKey(
  text: string,
  doc: Document,
  path: YamlPath,
  value: YamlScalarValue,
  eol: string,
): string {
  const target = findInsertionTarget(doc, path);
  if (target.map === null) {
    // Root is empty (or document had no content) — nothing to preserve, so a
    // plain render of the whole nested object is acceptable.
    return applyEol(new Document(buildNested(path, value)).toString(NO_WRAP), eol);
  }
  return spliceFragmentIntoMap(text, target.map, target.remaining, value, eol);
}

interface InsertionTarget {
  /** Deepest existing ancestor map, or `null` when the document root is empty. */
  map: YAMLMap | null;
  /** The not-yet-existing key chain to render under `map`. */
  remaining: YamlPath;
}

/**
 * Walk `path` from deepest to shallowest to find the deepest existing ancestor
 * map and the remaining (not-yet-existing) key chain to create under it.
 */
function findInsertionTarget(doc: Document, path: YamlPath): InsertionTarget {
  for (let i = path.length - 1; i >= 0; i--) {
    const prefix = path.slice(0, i);
    const node = prefix.length === 0 ? doc.contents : doc.getIn(prefix, true);
    if (node === null || node === undefined) {
      continue; // This ancestor does not exist yet — try a shallower one.
    }
    if (isMap(node)) {
      return { map: node, remaining: path.slice(i) };
    }
    throw new Error(
      `updateYamlIn: cannot insert at [${path.join(', ')}] — ancestor [${prefix.join(', ')}] is not a map`,
    );
  }
  return { map: null, remaining: path };
}

/** Build a right-nested plain object from a key chain and a leaf value. */
function buildNested(keys: YamlPath, value: YamlScalarValue): unknown {
  let acc: unknown = value;
  for (let i = keys.length - 1; i >= 0; i--) {
    acc = { [String(keys[i])]: acc };
  }
  return acc;
}

/** Render the new fragment, indent it to the map's child column, and splice it in. */
function spliceFragmentIntoMap(
  text: string,
  map: YAMLMap,
  remaining: YamlPath,
  value: YamlScalarValue,
  eol: string,
): string {
  const indent = childIndentOf(text, map);
  const rendered = new Document(buildNested(remaining, value)).toString(NO_WRAP).replace(/\n$/, '');
  const indented = rendered
    .split('\n')
    .map((line) => (line.length > 0 ? indent + line : line))
    .join(eol);

  const insertAt = insertionOffset(map);
  const needsLeadingEol = insertAt > 0 && text[insertAt - 1] !== '\n';
  const piece = (needsLeadingEol ? eol : '') + indented + eol;
  return text.slice(0, insertAt) + piece + text.slice(insertAt);
}

/** The leading whitespace string for `map`'s children, derived from its first item's key. */
function childIndentOf(text: string, map: YAMLMap): string {
  const firstKey = map.items[0]?.key as Node | undefined;
  const keyRange = firstKey?.range;
  if (!keyRange) {
    throw new Error(
      'updateYamlIn: cannot determine child indentation for an empty map (insert target has no existing items)',
    );
  }
  return ' '.repeat(columnAt(text, keyRange[0]));
}

/** Byte offset to splice a new item at: the end of the map's content. */
function insertionOffset(map: YAMLMap): number {
  if (map.range == null) {
    throw new Error('updateYamlIn: insertion target map has no source range');
  }
  return map.range[1];
}

// ---------------------------------------------------------------------------
// verifyConfinedYamlEdit helpers
// ---------------------------------------------------------------------------

function assertChangedPathsLanded(afterDoc: Document, changedPaths: YamlPath[]): void {
  for (const path of changedPaths) {
    if (!afterDoc.hasIn(path)) {
      throw new Error(
        `verifyConfinedYamlEdit: changed path [${path.join(', ')}] did not land in 'after'`,
      );
    }
  }
}

function assertConfinement(
  beforeDoc: Document,
  afterDoc: Document,
  changedPaths: YamlPath[],
): void {
  const changed = new Set(changedPaths.map((p) => JSON.stringify(p)));
  const beforeJs = beforeDoc.toJS() ?? {};
  const afterJs = afterDoc.toJS() ?? {};

  const leaves: { path: YamlPath; value: unknown }[] = [];
  collectLeafPaths(beforeJs, [], leaves);

  for (const leaf of leaves) {
    if (changed.has(JSON.stringify(leaf.path))) {
      continue;
    }
    const found = getAtPath(afterJs, leaf.path);
    if (!found.present || !Object.is(found.value, leaf.value)) {
      const actual = found.present ? JSON.stringify(found.value) : '(removed)';
      throw new Error(
        `verifyConfinedYamlEdit: value at [${leaf.path.join(', ')}] changed from ` +
          `${JSON.stringify(leaf.value)} to ${actual} — edit was not confined`,
      );
    }
  }
}

function assertCommentsPreserved(beforeDoc: Document, afterDoc: Document): void {
  const before = collectComments(beforeDoc).sort((a, b) => a.localeCompare(b));
  const after = collectComments(afterDoc).sort((a, b) => a.localeCompare(b));
  if (before.length === after.length && before.every((c, i) => c === after[i])) {
    return;
  }
  const dropped = multisetDifference(before, after);
  const added = multisetDifference(after, before);
  throw new Error(
    `verifyConfinedYamlEdit: comment set changed — dropped ${JSON.stringify(dropped)}, ` +
      `added ${JSON.stringify(added)}`,
  );
}

/** Recursively collect every leaf (primitive/null) path and its value. */
function collectLeafPaths(node: unknown, prefix: YamlPath, out: { path: YamlPath; value: unknown }[]): void {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      collectLeafPaths(item, [...prefix, index], out);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      collectLeafPaths(val, [...prefix, key], out);
    }
    return;
  }
  out.push({ path: prefix, value: node });
}

/** Walk a plain JS structure by path; report presence to distinguish `undefined` from missing. */
function getAtPath(root: unknown, path: YamlPath): { present: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      return { present: false, value: undefined };
    }
    const key = String(segment);
    if (!Object.hasOwn(current, key)) {
      return { present: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[key];
  }
  return { present: true, value: current };
}

/** Collect every comment string attached anywhere in the document. */
function collectComments(doc: Document): string[] {
  const comments: string[] = [];
  pushComment(comments, doc.commentBefore);
  pushComment(comments, doc.comment);
  visit(doc, {
    Node(_key, node: Node) {
      pushComment(comments, node.commentBefore);
      pushComment(comments, node.comment);
    },
    Pair(_key, pair: Pair) {
      const keyNode = pair.key as Node | null;
      const valueNode = pair.value as Node | null;
      pushComment(comments, keyNode?.commentBefore);
      pushComment(comments, valueNode?.comment);
    },
  });
  return comments;
}

function pushComment(out: string[], comment: string | null | undefined): void {
  if (comment != null && comment !== '') {
    out.push(comment);
  }
}

/** Items in `a` that are not balanced by an equal item in `b` (multiset semantics). */
function multisetDifference(a: string[], b: string[]): string[] {
  const remaining = [...b];
  const diff: string[] = [];
  for (const item of a) {
    const idx = remaining.indexOf(item);
    if (idx === -1) {
      diff.push(item);
    } else {
      remaining.splice(idx, 1);
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/** Detect the document's EOL convention. Mixed/absent endings default to `\n`. */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Rewrite `\n` line breaks in `token` to the target EOL (no-op for `\n`). */
function applyEol(token: string, eol: string): string {
  return eol === '\n' ? token : token.split('\n').join(eol);
}

/** The 0-based column (in characters) of byte `offset` within its line. */
function columnAt(text: string, offset: number): number {
  let column = 0;
  for (let i = 0; i < offset; i++) {
    column = text[i] === '\n' ? 0 : column + 1;
  }
  return column;
}
