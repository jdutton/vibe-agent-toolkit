/**
 * The derived `data__values` relation: every routed path joined to the nodes of its row set that no
 * later sibling shadows. Pure: the data stage hands it the routes and the nodes it read through the
 * run's reader (store on) or holds in hand (store off), so both backings build it identically.
 *
 * The last occurrence of a key wins (the fact layer's one meaning of a duplicate key): a node the
 * extractor marked `shadowed`, itself or through an ancestor, has no row, so `{"a": {"x": 1}, "a":
 * {"y": 2}}` answers `/a` and `/a/y`, never `/a/x`. The relation's key `(root, path, variant,
 * doc, pointer)` is unique as stored text too: the extractor refuses a key holding a lone surrogate
 * (`DATA_LONE_SURROGATE`), the one way two distinct JavaScript keys encode to one UTF-8 string.
 */

import type { DataNodeRow, DataRouteRow, DataValueRow } from '../schemas/projection-data.js';

import { rowSetIdText, type RowSetIdText } from './row-set-id.js';

/**
 * The row set a route or a node belongs to, as text.
 *
 * @param blob - The content key
 * @param variant - The variant
 * @returns Its id text
 */
function pairText(blob: DataNodeRow['blob'], variant: DataNodeRow['variant']): RowSetIdText {
  return rowSetIdText({ contentKey: blob, instance: 'data', variant });
}

/**
 * Build `data__values`: for each route whose pair is `facts`, in route order, its row set's
 * unshadowed nodes, in the order given (primary-key order).
 *
 * @param routes - The run's `data__routes` rows
 * @param nodes - The `data__nodes` rows of the routed `facts` pairs
 * @returns The relation's rows
 */
export function dataValueRows(routes: readonly DataRouteRow[], nodes: readonly DataNodeRow[]): DataValueRow[] {
  const byPair = new Map<RowSetIdText, DataNodeRow[]>();
  for (const node of nodes) {
    if (node.shadowed) continue;
    const text = pairText(node.blob, node.variant);
    const held = byPair.get(text);
    if (held === undefined) byPair.set(text, [node]);
    else held.push(node);
  }
  return routes.flatMap((route) => {
    if (route.state !== 'facts' || route.blob === null) return [];
    return (byPair.get(pairText(route.blob, route.variant)) ?? []).map((node) => ({
      root: route.root,
      path: route.path,
      variant: route.variant,
      doc: node.doc,
      pointer: node.pointer,
      key: node.key,
      depth: node.depth,
      type: node.type,
      value: node.value,
      lexeme: node.lexeme,
      line: node.line,
    }));
  });
}
