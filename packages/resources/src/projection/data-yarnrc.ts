/**
 * The `data` instance's extractor for variant `yarnrc`: a `.yarnrc.yml`'s YAML
 * rows (`data-yaml.ts`), kept only through a key allowlist, so a Yarn auth
 * token never becomes a row.
 *
 * It runs in the parse worker only (ADR I8): `data-extractor.ts` is its one
 * importer. It parses nothing and imports no parser library; it filters what
 * the YAML extractor answered.
 *
 * ## The allowlist, never secrets
 *
 * A `.yarnrc.yml` routinely holds `npmAuthToken` and `npmAuthIdent`, top level
 * and under each `npmScopes.<scope>` and `npmRegistries.<registry>`.
 * {@link YARNRC_ALLOWED_KEYS} is the reviewed list of the only top-level keys
 * kept: adding one is a code change reviewed as one, and a key not on it (an
 * `httpProxy` URL can hold a password) is dropped with its whole subtree. Under a
 * kept key, every member whose key starts with `npmAuth` is dropped, with its
 * subtree, at any depth. A row that copies a dropped row through an alias is
 * dropped too, so `nodeLinker: *token` cannot carry a token into a kept key.
 * The root of a document is always kept; a root that is not a map keeps nothing
 * else.
 *
 * A defect or a cap breach is returned as the YAML extractor answered it: its
 * message names a YAML error code, a directive or an alias name and a place,
 * never a value. The kept rows keep their source line and column; ordinals,
 * parents, child counts, `aliasOf`, condition sequence numbers and the
 * documents' and file's counts and depths are renumbered over what is kept. A
 * condition a dropped row raised is dropped with it.
 */

import type { OutputLimitName, ParseLimits } from '../parse-limits.js';

import type { DataExtraction, ExtractedDataCondition, ExtractedDataDocument, ExtractedDataNode, ExtractedDataRows } from './data-extractor.js';
import { settleRows } from './data-row-rules.js';

/**
 * The reviewed list of the only top-level `.yarnrc.yml` keys kept. Anything
 * else in the file may be a credential.
 */
const YARNRC_ALLOWED_KEYS: readonly string[] = [
  'checksumBehavior',
  'compressionLevel',
  'defaultSemverRangePrefix',
  'enableGlobalCache',
  'enableImmutableInstalls',
  'enableScripts',
  'enableStrictSsl',
  'enableTelemetry',
  'nmHoistingLimits',
  'nmMode',
  'nodeLinker',
  'npmPublishAccess',
  'npmPublishRegistry',
  'npmRegistries',
  'npmRegistryServer',
  'npmScopes',
  'packageExtensions',
  'plugins',
  'pnpMode',
  'supportedArchitectures',
  'yarnPath',
];

const ALLOWED: ReadonlySet<string> = new Set(YARNRC_ALLOWED_KEYS);

/** Yarn's auth settings all start so (`npmAuthToken`, `npmAuthIdent`): dropped at any depth. */
const AUTH_KEY_PREFIX = 'npmAuth';

/** A node's identity across the stream: ordinals restart per document. */
const idOf = (doc: number, ordinal: number): string => `${String(doc)}:${String(ordinal)}`;

/**
 * Whether one node is kept, given what was decided for the nodes before it (a
 * parent and an anchored original always come first in pre-order).
 */
function isKept(node: ExtractedDataNode, kept: ReadonlyMap<string, number>, rootIsMap: boolean): boolean {
  if (node.parent === null) return true;
  if (!kept.has(idOf(node.doc, node.parent))) return false;
  if (node.aliasOf !== null && !kept.has(idOf(node.doc, node.aliasOf))) return false;
  if (node.depth === 2 && !(rootIsMap && node.key !== null && ALLOWED.has(node.key))) return false;
  return !(node.key?.startsWith(AUTH_KEY_PREFIX) ?? false);
}

/** The largest depth of a container among the nodes; 0 when there is none. */
function maxContainerDepth(nodes: readonly ExtractedDataNode[]): number {
  let deepest = 0;
  for (const node of nodes) if (node.type === 'object' || node.type === 'array') deepest = Math.max(deepest, node.depth);
  return deepest;
}

/**
 * Keep a `.yarnrc.yml`'s YAML extraction through the allowlist.
 *
 * @param extraction - What `extractYamlRows` answered for the file
 * @param limits - The output caps in force
 * @returns The kept rows, or the extraction's own defect or breach
 */
export function keptYarnrcRows(extraction: DataExtraction, limits: Pick<ParseLimits, OutputLimitName>): DataExtraction {
  if (extraction.outcome !== 'rows') return extraction;
  const { rows } = extraction;
  const rootIsMap = new Set(rows.documents.filter(({ rootType }) => rootType === 'object').map(({ doc }) => doc));
  const kept = new Map<string, number>();
  const nextOrdinal = new Map<number, number>();
  const nodes: ExtractedDataNode[] = [];
  for (const node of rows.nodes) {
    if (!isKept(node, kept, rootIsMap.has(node.doc))) continue;
    const ordinal = nextOrdinal.get(node.doc) ?? 0;
    nextOrdinal.set(node.doc, ordinal + 1);
    kept.set(idOf(node.doc, node.ordinal), ordinal);
    const mapped = (old: number | null): number | null => (old === null ? null : (kept.get(idOf(node.doc, old)) ?? null));
    nodes.push({ ...node, ordinal, parent: mapped(node.parent), aliasOf: mapped(node.aliasOf), childCount: 0 });
  }
  const childCounts = new Map<string, number>();
  for (const node of nodes) if (node.parent !== null) childCounts.set(idOf(node.doc, node.parent), (childCounts.get(idOf(node.doc, node.parent)) ?? 0) + 1);
  const counted = nodes.map((node) => ({ ...node, childCount: childCounts.get(idOf(node.doc, node.ordinal)) ?? 0 }));

  const nextSeq = new Map<number, number>();
  const conditions: ExtractedDataCondition[] = rows.conditions.flatMap((condition) => {
    const node = condition.node === null ? null : kept.get(idOf(condition.doc, condition.node));
    if (node === undefined) return [];
    const seq = nextSeq.get(condition.doc) ?? 0;
    nextSeq.set(condition.doc, seq + 1);
    return [{ ...condition, seq, node }];
  });
  const documents: ExtractedDataDocument[] = rows.documents.map((document) => {
    const own = counted.filter(({ doc }) => doc === document.doc);
    return { ...document, nodeCount: own.length, maxDepth: maxContainerDepth(own) };
  });
  const filtered: ExtractedDataRows = {
    files: [{ ...rows.files[0], nodeCount: counted.length, maxDepth: maxContainerDepth(counted) }],
    documents,
    nodes: counted,
    conditions,
  };
  return settleRows(filtered, limits);
}
