/**
 * Pure schema/data traversal that captures every string value sitting at a
 * JSON Schema position whose `format` is in the URI family.
 *
 * Handles:
 *  - `properties` (recursion)
 *  - `items` (single-schema and tuple)
 *  - `oneOf` / `anyOf` / `allOf` (every branch walked) AND sibling keywords
 *    in the same node (JSON Schema AND semantics)
 *  - `$ref` (resolved against schema root via JSON Pointer; cycle-protected)
 *  - `definitions` and `$defs` as ref targets
 *
 * Does NOT handle (intentional, see spec §"Non-Goals"):
 *  - `if`/`then`/`else`, `dependentSchemas`
 *  - `patternProperties`, schema-form `additionalProperties`
 *  - `prefixItems` (JSON Schema 2020-12)
 *
 * Captures are deduplicated by `(pointer, value)` before return so that
 * multiple matching composite branches don't produce duplicate issues.
 *
 * No I/O. No side effects.
 */

import { decodeJsonPointerSegment, encodeJsonPointerSegment, formatJsonPointerAsDotted } from './utils.js';

const URI_FAMILY_FORMATS = new Set<UriFamilyFormat>([
  'uri-reference',
  'uri',
  'iri-reference',
  'iri',
]);

export type UriFamilyFormat = 'uri' | 'uri-reference' | 'iri' | 'iri-reference';

export interface FrontmatterUriCapture {
  /** Raw string value from frontmatter */
  value: string;
  /** RFC 6901 JSON Pointer to the value within the frontmatter document */
  pointer: string;
  /** Developer-friendly dotted form (e.g., adr-citations[0].adr) */
  dottedPath: string;
  /** The URI-family format keyword present on the schema node */
  format: UriFamilyFormat;
}

interface SchemaNode {
  type?: string | string[];
  format?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
  $ref?: string;
  // $defs / definitions / etc. are arbitrary root-level keys reached via $ref.
  [key: string]: unknown;
}

/**
 * Walk a frontmatter document against a JSON Schema and return every value
 * whose schema position has a URI-family `format` keyword.
 */
export function walkFrontmatterUriReferences(
  data: unknown,
  schema: object,
): FrontmatterUriCapture[] {
  if (data === undefined || data === null) return [];
  const captures: FrontmatterUriCapture[] = [];
  walk(data, schema as SchemaNode, schema as SchemaNode, [], new Set<string>(), captures);
  return dedupe(captures);
}

function walkComposites(
  data: unknown,
  node: SchemaNode,
  root: SchemaNode,
  pointerSegments: string[],
  visitedRefs: Set<string>,
  captures: FrontmatterUriCapture[],
): void {
  for (const branchList of [node.oneOf, node.anyOf, node.allOf]) {
    if (Array.isArray(branchList)) {
      for (const branch of branchList) {
        walk(data, branch, root, pointerSegments, visitedRefs, captures);
      }
    }
  }
}

function walkProperties(
  data: unknown,
  node: SchemaNode,
  root: SchemaNode,
  pointerSegments: string[],
  visitedRefs: Set<string>,
  captures: FrontmatterUriCapture[],
): void {
  if (!node.properties || data === null || typeof data !== 'object' || Array.isArray(data)) return;
  const dataObj = data as Record<string, unknown>;
  for (const [key, propSchema] of Object.entries(node.properties)) {
    if (key in dataObj) {
      walk(
        dataObj[key],
        propSchema,
        root,
        [...pointerSegments, encodeJsonPointerSegment(key)],
        visitedRefs,
        captures,
      );
    }
  }
}

function walkItems(
  data: unknown,
  node: SchemaNode,
  root: SchemaNode,
  pointerSegments: string[],
  visitedRefs: Set<string>,
  captures: FrontmatterUriCapture[],
): void {
  if (!node.items || !Array.isArray(data)) return;
  if (Array.isArray(node.items)) {
    const tupleSchemas = node.items;
    for (const [i, itemValue] of data.entries()) {
      if (i >= tupleSchemas.length) break;
      walk(itemValue, tupleSchemas[i] as SchemaNode, root, [...pointerSegments, String(i)], visitedRefs, captures);
    }
  } else {
    for (const [i, itemValue] of data.entries()) {
      walk(itemValue, node.items, root, [...pointerSegments, String(i)], visitedRefs, captures);
    }
  }
}

function walk(
  data: unknown,
  node: SchemaNode,
  root: SchemaNode,
  pointerSegments: string[],
  visitedRefs: Set<string>,
  captures: FrontmatterUriCapture[],
): void {
  if (!node || typeof node !== 'object') return;

  // Resolve $ref against schema root. Cycle protection: skip if already on the
  // recursion stack. Pop after recursion.
  if (typeof node.$ref === 'string') {
    if (visitedRefs.has(node.$ref)) return;
    const resolved = resolveRef(node.$ref, root);
    if (!resolved) return;
    visitedRefs.add(node.$ref);
    walk(data, resolved, root, pointerSegments, visitedRefs, captures);
    visitedRefs.delete(node.$ref);
    return;
  }

  // Composite schemas: walk every branch. CRITICAL: do NOT short-circuit;
  // sibling `properties`/`items` are AND-combined with the composite.
  walkComposites(data, node, root, pointerSegments, visitedRefs, captures);

  // URI-family format leaf
  if (
    typeof node.format === 'string' &&
    URI_FAMILY_FORMATS.has(node.format as UriFamilyFormat) &&
    typeof data === 'string'
  ) {
    const pointer = pointerSegments.length === 0 ? '' : '/' + pointerSegments.join('/');
    captures.push({
      value: data,
      pointer,
      dottedPath: formatJsonPointerAsDotted(pointer),
      format: node.format as UriFamilyFormat,
    });
    // Fall through — schemas with both `format` and sibling object/array
    // structure are unusual but possible; let recursion proceed.
  }

  // Object recursion
  walkProperties(data, node, root, pointerSegments, visitedRefs, captures);

  // Array recursion
  walkItems(data, node, root, pointerSegments, visitedRefs, captures);

  // Intentionally NOT handled: if/then/else, dependentSchemas, patternProperties,
  // schema-form additionalProperties, prefixItems (2020-12). See spec §"Non-Goals".
}

/**
 * Resolve a local $ref (e.g., "#/$defs/Foo") against the schema root using a
 * generic JSON Pointer walk. Returns null for unresolvable refs or non-local
 * refs (no cross-file support in v1).
 */
function resolveRef(ref: string, root: SchemaNode): SchemaNode | null {
  if (!ref.startsWith('#/')) return null;
  // eslint-disable-next-line local/no-hardcoded-path-split -- RFC 6901 JSON Pointer segment splitting, not a file path
  const segments = ref.slice(2).split('/').map(decodeJsonPointerSegment);
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[seg];
    if (cursor === undefined) return null;
  }
  return (cursor as SchemaNode) ?? null;
}

/**
 * Remove duplicate captures by (pointer, value). Multiple matching branches
 * of `oneOf`/`anyOf`/`allOf` can produce duplicates; users should see one
 * issue per field, not one per branch.
 */
function dedupe(captures: FrontmatterUriCapture[]): FrontmatterUriCapture[] {
  const seen = new Set<string>();
  const out: FrontmatterUriCapture[] = [];
  for (const c of captures) {
    const key = c.pointer + ' ' + c.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
