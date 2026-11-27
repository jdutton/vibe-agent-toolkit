/**
 * The `data` instance's extractor for variant `ini`: one `.npmrc`'s decoded
 * text in, its row set out, in the same `data__*` shape the JSON variants fill,
 * as ONE document whose root is an object.
 *
 * It runs in the parse worker only (ADR I8): `data-extractor.ts` is its one
 * importer, held by `packages/dev-tools/test/parser-import-boundary.test.ts`.
 * The rules every variant shares (positions, last occurrence wins, the caps)
 * are `data-row-rules.ts`; this module decides only what `.npmrc` adds.
 *
 * ## The allowlist, never secrets
 *
 * An `.npmrc` routinely holds credentials (`_authToken`, `_auth`, `_password`,
 * `//<registry>/:...`). {@link NPMRC_ALLOWED_KEYS} is the reviewed list of the
 * only keys stored: adding one is a code change reviewed as one. Every other
 * key, and everything from the first `[section]` header on (an allowlisted key
 * included), is dropped here before any row, condition or message is built. No
 * condition or message this module builds quotes a value or a line of the file:
 * `ini` never refuses a line (one it cannot read it skips), so there is no parse
 * error to report, and the only other answers are a cap's name and count.
 *
 * ## The parse
 *
 * npm's own `ini` package, the parser npm reads `.npmrc` with, applied one line
 * at a time so that each kept occurrence has a line: the text is split by the
 * shared line table (CR, LF and CRLF one break each, as `ini`'s own
 * `/[\r\n]+/` split, which only also drops empty lines), and each line is
 * `ini.decode`d on its own, so `ini` alone decides comments, quoting,
 * whitespace and `__proto__`. A line that decodes to an object is a section
 * header; the scan stops there. A line that decodes to an array is the
 * bracketed-array form (`key[]=v`), which is no setting npm or pnpm reads as
 * a scalar: it is dropped, even for an allowlisted key.
 *
 * ## Rows
 *
 * The root object at depth 1 (line 1, column 1), then each kept occurrence as
 * a member at depth 2, pointer `/<key>` (escaped by `encodeJsonPointerSegment`),
 * placed at its key: the line's first character that is not whitespace. A value
 * is exactly what `ini` returns for it: a string (`${VAR}` stored literally,
 * never expanded: the environment is not a file fact), or, since `ini` turns
 * `true`, `false` and `null` (quoted or not) into JSON values and a bare key
 * into `true`, a boolean or null node. Never a number: `lexeme` is null on
 * every row, so no number is lossy. `tag` and `aliasOf` are null.
 *
 * A repeated kept key is decided from the keys alone (never a value) by the
 * shared rule: `ini` reads it last-wins, every earlier occurrence is
 * `shadowed`, and each repeat raises one `DATA_DUPLICATE_KEY`, whose message
 * names the (allowlisted) key and never a value.
 */

import { createRequire } from 'node:module';

import type { ParseLimits } from '../parse-limits.js';
import type { DataNodeType } from '../schemas/projection-data.js';
import { encodeJsonPointerSegment } from '../utils.js';

import type { DataExtraction, DataOutputLimitName, ExtractedDataCondition, ExtractedDataNode } from './data-extractor.js';
import { lineStarts, loneSurrogateDefect, memberOrder, positionOf, pushNodeConditions, settleRows } from './data-row-rules.js';

/** The slice of `ini`'s API read here (it ships no types). */
interface IniLibrary {
  decode(text: string): Record<string, unknown>;
}

/**
 * `ini`, loaded by a literal `createRequire`: it is CommonJS with no `exports`
 * map and no types, as `jsonc-parser` is in `data-extractor.ts`.
 */
const ini = createRequire(import.meta.url)('ini') as IniLibrary;

/**
 * The reviewed list of the only top-level `.npmrc` keys stored. Adding a key is
 * a code change reviewed as one: anything else in the file may be a credential.
 */
export const NPMRC_ALLOWED_KEYS: readonly string[] = ['link-workspace-packages'];

const ALLOWED: ReadonlySet<string> = new Set(NPMRC_ALLOWED_KEYS);

/** The only document an `.npmrc` holds. */
const DOC = 0;

/** A value `ini` returns for a key: a string, or the boolean or null it reads `true`, `false` and `null` (and a bare key) as. */
type IniScalar = string | boolean | null;

/** One kept top-level occurrence: its key, the value `ini` returns, and where its key starts. */
interface Kept {
  readonly key: string;
  readonly value: IniScalar;
  readonly offset: number;
}

/**
 * Extract one `.npmrc`'s row set.
 *
 * @param text - The decoded text, BOM stripped
 * @param bom - Whether its bytes had a BOM
 * @param limits - The output caps in force
 * @returns The rows, or the output cap breached
 */
export function extractIniRows(text: string, bom: boolean, limits: Pick<ParseLimits, DataOutputLimitName>): DataExtraction {
  const lines = lineStarts(text);
  const kept = keptOccurrences(text, lines);
  const lone = kept.find(({ value }) => typeof value === 'string' && !value.isWellFormed());
  if (lone !== undefined) return loneSurrogateDefect({ inKey: false, offset: lone.offset }, lines);

  const nodes: ExtractedDataNode[] = [{
    doc: DOC, ordinal: 0, parent: null, pointer: '', key: null, idx: null, depth: 1, type: 'object', value: null,
    lexeme: null, childCount: kept.length, tag: null, aliasOf: null, shadowed: false, line: 1, column: 1,
  }];
  const conditions: ExtractedDataCondition[] = [];
  const order = memberOrder(kept.map(({ key }) => key));
  for (const [index, member] of kept.entries()) {
    const { shadowed, repeat } = order[index] as (typeof order)[number];
    const row: ExtractedDataNode = {
      doc: DOC,
      ordinal: nodes.length,
      parent: 0,
      pointer: `/${encodeJsonPointerSegment(member.key)}`,
      key: member.key,
      idx: null,
      depth: 2,
      type: typeOf(member.value),
      value: member.value,
      lexeme: null,
      childCount: 0,
      tag: null,
      aliasOf: null,
      shadowed,
      ...positionOf(member.offset, lines),
    };
    nodes.push(row);
    pushNodeConditions(conditions, row, { repeatIn: repeat ? '' : null, nonStringKey: false });
  }
  return settleRows({
    files: [{ documents: 1, bom, nodeCount: nodes.length, maxDepth: 1 }],
    documents: [{ doc: DOC, rootType: 'object', nodeCount: nodes.length, maxDepth: 1 }],
    nodes,
    conditions,
  }, limits);
}

/**
 * Every allowlisted top-level occurrence, in file order. Each line is decoded
 * by `ini` alone; what it returns for a key not on the list is never kept.
 *
 * @param text - The decoded text
 * @param lines - {@link lineStarts} of the text
 * @returns The kept occurrences
 */
function keptOccurrences(text: string, lines: readonly number[]): Kept[] {
  const kept: Kept[] = [];
  for (const [index, start] of lines.entries()) {
    const line = text.slice(start, lines[index + 1] ?? text.length).trimEnd();
    // A section header, by ini's own line rule: nothing from here on is top level. Decided from the
    // line, not from what `ini` returns, which is an object for a JSON-quoted value too and nothing
    // at all for `[__proto__]`.
    if (SECTION_HEADER.test(line)) break;
    const [entry] = Object.entries(ini.decode(line));
    if (entry === undefined) continue;
    const [key, value] = entry;
    if (!ALLOWED.has(key) || !isScalar(value)) continue;
    kept.push({ key, value, offset: start + line.length - line.trimStart().length });
  }
  return kept;
}

/** A section header line, as `ini`'s decoder matches one (`^\[([^\]]*)\]\s*$`). */
const SECTION_HEADER = /^\[[^\]]*\]\s*$/;

/** Whether `ini` returned a scalar: a string, boolean or null (never the bracketed-array form). */
function isScalar(value: unknown): value is IniScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

/** The node type of a value `ini` returned. */
function typeOf(value: IniScalar): DataNodeType {
  if (value === null) return 'null';
  return typeof value === 'string' ? 'string' : 'boolean';
}
