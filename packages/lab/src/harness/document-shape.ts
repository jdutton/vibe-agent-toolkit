/**
 * Parse a command's stdout and say which of two shapes it is: the `Report<T>`
 * envelope every command has published since rc.11, or an older, per-command
 * "legacy" document. Every other reader in this package — `lane.ts`, the
 * `population` and `verdict` facets — reads a subject's output THROUGH this
 * module rather than re-parsing it, so the two-shape question is answered once.
 *
 * ## Why `ENVELOPE_IDENTITY_KEYS` is a frozen literal, not an import
 *
 * `@vibe-agent-toolkit/schema` exports `REPORT_ENVELOPE_KEYS` — the live list,
 * for the schema's OWN tests to assert every `Report<T>` shape still carries.
 * This module does not import it. The lab's job is to keep recognising a
 * document an OLD vat build printed, forever — that is the whole point of an
 * instrument that measures change across builds. If this list instead tracked
 * the schema import, a later vat that adds a sixth envelope key (or renames
 * one) would silently change what `parseDocument` calls a "report" here, and
 * every report this package has already stored from an rc.11-era build would
 * either stop matching or start matching for the wrong reason. Freezing the
 * five keys this module has always looked for is what keeps the classifier
 * itself a fixed point; {@link ENVELOPE_IDENTITY_KEYS} only ever equals
 * `REPORT_ENVELOPE_KEYS` on the day this file was written, and a test
 * (`document-shape.test.ts`) asserts the frozen list stays a SUBSET of the live
 * one — never the reverse, and never equality — so the schema is free to grow
 * without this classifier moving underneath it.
 *
 * ## Why identity is five keys plus two type checks, not a full schema
 *
 * `reportSchema()` is `.strict()` and typed per command's own `data`. This
 * reader has neither: it sees one string of stdout from a vat whose version it
 * may not even know, so it cannot pick a `data` schema to validate against, and
 * `.strict()` would refuse a future command that adds a legitimate sixth field.
 * The identity check is deliberately the narrowest thing that still separates
 * every legacy document this package has fixtures for from every `Report`: all
 * five keys present, `examined` a number (not `filesScanned`, `skillsValidated`,
 * or any of legacy's per-command names for the same idea), and `findings` an
 * array (not `issues`, and not absent). No version string is checked — none of
 * these documents carries one — and neither is `summary`'s shape: `vat audit`'s
 * legacy document ALSO has a key named `summary`, as an object, which is
 * exactly the trap `document-shape.test.ts` names: two documents can share a
 * key's name and even its JSON type without agreeing on what it means, so this
 * reader classifies on the keys that are unique to the envelope's shape
 * (`examined`, `findings`) and never on `summary`.
 */

import { parseAllDocuments } from 'yaml';

/**
 * The five keys every rc.11-and-later `Report<T>` carries. FROZEN: the lab
 * measures old builds — see this module's docstring for why this is not an
 * import of the schema's own (live) `REPORT_ENVELOPE_KEYS`.
 */
export const ENVELOPE_IDENTITY_KEYS = ['status', 'examined', 'findings', 'summary', 'data'] as const;

/**
 * A command's stdout, parsed and classified.
 *
 * `document` is always the root value as parsed (JSON or YAML); `payload` is
 * what a caller should actually read fields off — `document.data` for a
 * report (the command's own reported content, past the envelope), and
 * `document` itself for a legacy document (which has no envelope to unwrap).
 * Keeping both lets a facet that only cares about the payload ignore the
 * distinction, while a facet that needs the envelope's own fields (the
 * `findings` array, `examined`) still has `document`.
 */
export type ParsedDocument =
  | { readonly shape: 'report'; readonly document: Record<string, unknown>; readonly payload: unknown }
  | { readonly shape: 'legacy'; readonly document: Record<string, unknown>; readonly payload: unknown }
  | { readonly shape: 'unparsed'; readonly reason: string };

/**
 * Parse one JSON value, distinguishing "not JSON" from every other outcome.
 *
 * @param stdout - The candidate text
 * @returns The parsed value, or `undefined` when `stdout` is not JSON at all
 */
function tryParseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

/**
 * Parse one YAML document, distinguishing "not exactly one document" from every other outcome.
 *
 * @param stdout - The candidate text
 * @returns The root value, or a reason it could not be read as YAML
 */
function tryParseYaml(stdout: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  const docs = parseAllDocuments(stdout);
  if (docs.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one YAML document, found ${String(docs.length)}`,
    };
  }
  const [doc] = docs;
  /* c8 ignore next -- length === 1 guarantees an element; guards noUncheckedIndexedAccess */
  if (doc === undefined) return { ok: false, reason: 'no YAML document' };
  if (doc.errors.length > 0) {
    return { ok: false, reason: `YAML parse error: ${doc.errors[0]?.message ?? 'unknown'}` };
  }
  return { ok: true, value: doc.toJS() };
}

/**
 * Is `value` a `Report<T>` envelope's root object?
 *
 * @param value - A parsed document's root value
 * @returns True iff every identity key is present, `examined` is a number, and
 *   `findings` is an array
 */
function isReportRoot(value: Record<string, unknown>): boolean {
  for (const key of ENVELOPE_IDENTITY_KEYS) {
    if (!(key in value)) return false;
  }
  return typeof value['examined'] === 'number' && Array.isArray(value['findings']);
}

/**
 * Classify an already-parsed root object.
 *
 * @param document - The parsed root, known to be a plain object
 * @returns The document, shaped as `report` or `legacy`
 */
function classify(document: Record<string, unknown>): ParsedDocument {
  return isReportRoot(document)
    ? { shape: 'report', document, payload: document['data'] }
    : { shape: 'legacy', document, payload: document };
}

/**
 * Parse a command's stdout and classify it.
 *
 * JSON is tried first, then YAML (a single document; a leading `---` is
 * tolerated, since that is how `vat resources scan`'s default output opens).
 * Neither parser throws out of this function — every failure to read a root
 * object becomes `{ shape: 'unparsed' }` with a reason, never an exception a
 * caller must remember to catch.
 *
 * @param stdout - Everything the command wrote to stdout
 * @returns The parsed document, classified
 */
export function parseDocument(stdout: string): ParsedDocument {
  const asJson = tryParseJson(stdout);
  const root = asJson === undefined ? tryParseYaml(stdout) : { ok: true as const, value: asJson };
  if (!root.ok) return { shape: 'unparsed', reason: root.reason };

  const { value } = root;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { shape: 'unparsed', reason: 'root value is not an object' };
  }
  return classify(value as Record<string, unknown>);
}
