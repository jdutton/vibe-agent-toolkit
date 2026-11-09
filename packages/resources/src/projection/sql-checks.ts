/**
 * **`resources.checks`** — a project's own SQL assertions over its projection,
 * turned into ordinary validation findings.
 *
 * ## Why this exists, and why it is not just a saved query
 *
 * `vat resources query` answers a question once. A question worth asking twice
 * is a rule, and a rule nobody re-runs decays into a comment. A check is the
 * same statement written down where CI runs it, so the answer is asserted rather
 * than read.
 *
 * ## 🔑 The statement selects the VIOLATIONS. Zero rows is the pass.
 *
 * That direction is the design, not a convention:
 *
 * - Each returned row **is** a finding, and its columns are that finding's
 *   evidence — so a check needs no separate "how do I report this" declaration.
 * - An author cannot write an assertion that passes vacuously by selecting
 *   nothing, because selecting nothing is what success *means*. The inverse
 *   spelling (select what must exist, assert non-empty) has the opposite and much
 *   worse failure mode: a typo'd table name, a renamed column, a `WHERE` that
 *   matches nothing — every one of them returns zero rows and reads as a pass.
 *
 * 🔑 That second bullet is load-bearing prose held up by a gate in ANOTHER
 * package: `assertIsQuery` in `packages/projection-sqlite/src/store.ts` refuses
 * any statement whose first significant token is not `SELECT`, `WITH` or
 * `VALUES`. Without it the sentence is false in the direction that matters — an
 * author cannot pass vacuously by *selecting* nothing, but they could pass
 * vacuously by not asserting at all. Both `ATTACH DATABASE 'evil.db' AS e` and
 * `PRAGMA query_only = 0` were accepted, returned zero rows, and were counted as
 * PASSING checks; the `ATTACH` also left a zero-byte file in the project
 * directory. Do not weaken either half alone: this sentence is why that gate
 * exists, and that gate is why this sentence is not a hole.
 *
 * ## Why this module holds no SQL
 *
 * Only the CLI knows a storage backend exists (`utils/projection-store.ts` is
 * the single place in the toolkit that names `@vibe-agent-toolkit/projection-
 * sqlite`). So the CLI runs the statement and hands the rows here; this module
 * decides what they MEAN. That split is what keeps the rule engine testable
 * without a database, and keeps `resources` free of an engine choice.
 *
 * ## The `CUSTOM:` code space
 *
 * A check's findings are ordinary {@link ValidationIssue}s, so they flow through
 * the severity counts, the status calculation and the output formats every other
 * lane already uses. Their codes are namespaced `CUSTOM:<name>` because the
 * shipped registry's code space is **closed** and every entry carries a default
 * severity — a user-authored name landing in it would either shadow a shipped
 * code or crash `resolveSeverity`, which reads `CODE_REGISTRY[code]` unguarded.
 *
 * ⚠️ A `CUSTOM:` code therefore takes its severity from **the check's own
 * declaration** rather than from the registry, which holds no entry for it.
 *
 * A `resources.validation.severity` override reaches it. The key space is
 * widened for exactly this: `SeverityOverrideCodeSchema` in
 * `packages/schema/src/validation-config.ts` is a single `z.string()` constrained
 * by one pattern, `SEVERITY_KEY_PATTERN` — composed from the registry enum's own
 * code names alternated with `CUSTOM_CHECK_CODE_PATTERN_SOURCE` — so
 * `CUSTOM:<name>` parses as a `severity` key while a misspelled REGISTRY code is
 * still refused. Resolution is safe on the same key: `resolveIssueSeverity`
 * calls `resolveSeverity` only for a code the overrides map actually lists, and
 * `resolveSeverity` returns a listed value before it ever indexes
 * `CODE_REGISTRY`. So an adopter downgrades or ignores a check they inherited
 * without editing it — the declaration is the default, not a ceiling.
 *
 * ⚠️ **One pattern rather than a union, and that is not a style choice.** The
 * key space WAS `z.union([registry enum, isCustomCheckCode refinement])`, and
 * `zod-to-json-schema` has no case for a UNION record key: the emitted
 * `severity` silently lost its `propertyNames` entirely while `allow`, in the
 * same published file, kept its full enum. An adopter validating their config in
 * an editor then got a misspelled registry code accepted by the schema and
 * refused by `loadConfig`. A pattern emits as `propertyNames.pattern`, which
 * that generator does understand. Do not "simplify" it back into a union — see
 * `packages/schema/test/emitted-json-schemas.test.ts`, which asserts on the
 * generated artifact for exactly this reason.
 *
 * ⚠️ **The override reaches VIOLATIONS only.** A check that cannot run — a
 * renamed column, a table that is gone — is not reported under this code space
 * at all: `vat resources check` emits `RESOURCE_CHECK_BROKEN` at `error`. That
 * code is registered in `CODE_REGISTRY` as a **refusal**
 * (`packages/schema/src/validation-codes.ts`), a kind `ValidationConfigSchema`
 * refuses as a `severity` or `allow` key outright — unsilenceable by
 * construction rather than by convention. The two
 * used to share `CUSTOM:<name>`, which meant the documented way to stand down an
 * inherited check also silenced the news that it had stopped checking, and a
 * renamed projection column produced exit 0 from a gate. Downgrade the check as
 * far as you like; you cannot downgrade the report that it stopped asserting.
 */

import { customCheckCode, SEVERITIES, SeveritySchema } from '@vibe-agent-toolkit/schema';
import type { Severity, ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { ResourceCheck } from '../schemas/project-config.js';

import { findingLocation } from './finding-location.js';

/**
 * The code every statement a projection query store REFUSES to run carries:
 * not a query, a second statement, placeholders that do not pair with their
 * values, or SQLite's own refusal (a name the schema lacks, an unevaluated
 * derived relation). The backend (`@vibe-agent-toolkit/projection-sqlite`)
 * throws it; a caller tells "the statement is wrong" — the author's to fix —
 * from "the store failed" by this code, never by the message.
 */
export const PROJECTION_STATEMENT_REFUSED_CODE = 'PROJECTION_STATEMENT_REFUSED';

/**
 * The column names a check's row reads as something other than evidence.
 *
 * 🔑 Matched EXACTLY, case included. A result row keeps the spelling the
 * statement used, so `SELECT Finding_Line` and `SELECT finding_line` arrive as
 * different keys; only the exact one is reserved, and the other is a
 * {@link NearMiss}.
 *
 * 🔑 **`finding_` because no projection relation carries those names.** They
 * were `severity`, `line` and `column`, which `blob_conditions`,
 * `blob_references`, `harness_blob_imports` and `realization_conditions` carry
 * as their OWN columns — so `SELECT bc.*` overrode a check's declared severity
 * with a table's. Now a `SELECT *` cannot feed one, and the bare names are
 * ordinary evidence. `check-reserved-columns.test.ts` in projection-sqlite holds
 * every relation's columns to that; `path` stays `path`, the anchor every table
 * that names a file already calls it.
 */
export const CHECK_FINDING_COLUMNS = ['path', 'finding_severity', 'finding_line', 'finding_column'] as const;

/** One reserved column name. */
type ReservedCheckColumn = (typeof CHECK_FINDING_COLUMNS)[number];

/**
 * One evidence value as a finding publishes it: what SQLite returned when JSON
 * can carry it, else the text the message renders it as (a BLOB, a `bigint`).
 */
export type CheckEvidenceValue = string | number | boolean | null;

/**
 * A finding produced by one check: a {@link ValidationIssue} that names the
 * check and, for a declared check's violation, carries its row.
 *
 * 🔑 A separate type rather than a widened `ValidationIssue`: only
 * `vat resources check`'s document publishes these two keys, through its own
 * finding schema.
 */
export interface CheckIssue extends ValidationIssue {
  /** The check's key in `resources.checks`, or a built-in's name. */
  check?: string;
  /**
   * The row's columns minus the reserved ones, in the order SQLite returned
   * them. Present on a declared check's violation only.
   */
  evidence?: Record<string, CheckEvidenceValue>;
}

/**
 * A selected column whose name matches a reserved one only case-insensitively —
 * almost certainly meant as that column, and read as evidence instead.
 */
export interface NearMiss {
  /** The column as the statement spelled it. */
  readonly column: string;
  /** The reserved name it nearly is. */
  readonly reserved: ReservedCheckColumn;
}

/** A reserved column whose value can refuse a check: every one but `path`. */
type StrictCheckColumn = Exclude<ReservedCheckColumn, 'path'>;

/**
 * What one check's rows became.
 *
 * - `ok: true` — one finding per row, plus the near-miss column names a caller
 *   warns about once per check (every row of one statement has the same columns).
 * - `ok: false` — a row's reserved column held a value it cannot mean, so NONE
 *   of the rows were reported. `row` is 1-based; `field` is the SQL column NAME
 *   (never the finding's `column` coordinate); `rowsSelected` is how many rows
 *   the statement returned — it completed, so the count is real; `reason` is
 *   the predicate the value failed (`is not a positive integer`).
 */
export type CheckRowConversion =
  | {
    readonly ok: true;
    readonly issues: readonly CheckIssue[];
    readonly nearMisses: readonly NearMiss[];
  }
  | {
    readonly ok: false;
    readonly row: number;
    readonly field: StrictCheckColumn;
    readonly value: unknown;
    readonly rowsSelected: number;
    readonly reason: string;
  };

/** One row's reading of a reserved column: a value, nothing said, or a refusal. */
type Read<T> = { readonly ok: true; readonly value: T | undefined } | { readonly ok: false };

/** Why a `finding_severity` value was refused, as a predicate. */
const SEVERITY_REFUSAL = `is not one of ${SEVERITIES.join(', ')}`;
/** Why a `finding_line` or `finding_column` value was refused, as a predicate. */
const POSITION_REFUSAL = 'is not a positive integer';

/**
 * Turn one check's selected rows into findings.
 *
 * Four columns are RESERVED ({@link CHECK_FINDING_COLUMNS}): `path` anchors the
 * finding, `finding_severity` sets that row's severity, and `finding_line` /
 * `finding_column` place it. `NULL` or absent means "not said". Anything else in
 * the three `finding_` columns refuses the whole check rather than being guessed at — a row graded
 * `'high'` was written by someone who meant something, and reporting it at the
 * declared severity would re-grade it in silence. (`path` keeps its older rule:
 * an unusable value is dropped, see {@link locationOf}.)
 *
 * @param name - The check's key in `resources.checks`
 * @param check - Its declaration
 * @param rows - Exactly what the statement returned — undecoded, as SQLite holds
 *   it. See `SqlQueryableStore.query`: arbitrary SQL has no table spec, so a
 *   boolean arrives as `0`/`1` and a date as text. The message renders what is
 *   there rather than pretending otherwise
 * @returns One finding per row, in the order SQLite produced them, each naming
 *   the check and carrying its non-reserved columns as `evidence` — or the first
 *   row that could not be read
 */
export function issuesFromCheckRows(
  name: string,
  check: ResourceCheck,
  rows: readonly Record<string, unknown>[],
): CheckRowConversion {
  const issues: CheckIssue[] = [];
  for (const [index, row] of rows.entries()) {
    const read = readRow(row);
    if (!read.ok) {
      return { ok: false, row: index + 1, field: read.field, value: row[read.field], rowsSelected: rows.length, reason: read.reason };
    }
    const location = locationOf(row);
    issues.push({
      code: customCheckCode(name),
      // The row's own, else declared, else `error`. The safe direction: a check
      // whose author did not think about severity is still an assertion they
      // wanted enforced, and defaulting to `warning` would let it pass CI in
      // silence — which is the exact outcome writing a check was meant to prevent.
      severity: read.severity ?? check.severity ?? 'error',
      message: `${check.description} — ${renderRow(row)}`,
      // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
      // an absent key and one holding `undefined` different values, and
      // `ValidationIssue.location` is refined: it must be a project-relative
      // POSIX path or absent. There is no third state to put a placeholder in.
      ...(location === undefined ? {} : { location }),
      ...(read.line === undefined ? {} : { line: read.line }),
      ...(read.column === undefined ? {} : { column: read.column }),
      check: name,
      evidence: evidenceOf(row),
    });
  }
  return { ok: true, issues, nearMisses: nearMissesOf(rows[0]) };
}

/**
 * Every statement a check may run: its violations statement, then its declared
 * `examined` statement.
 *
 * 🔑 The one answer to "which statements can this check execute", so a caller
 * deciding what the run must prepare for — the derived relations a statement
 * names, above all — cannot see the violations statement and miss the other.
 *
 * @param check - Its declaration
 * @returns The statements, in the order the check runs them
 */
export function checkStatements(check: ResourceCheck): string[] {
  return check.examined === undefined ? [check.sql] : [check.sql, check.examined];
}

/**
 * The sentence for a check whose rows could not be read.
 *
 * Here rather than in the CLI because it is a statement about what the ROWS
 * meant — the value is rendered the way the finding's evidence renders it,
 * quoted when it is text so `"3"` and `3` read differently.
 *
 * @param name - The check's key in `resources.checks`
 * @param refusal - What {@link issuesFromCheckRows} refused
 * @returns e.g. `The check "x" ran and selected 3 rows, but row 3's finding_severity =
 *   "high" is not one of error, warning, info, so none of its rows were reported.`
 */
export function describeUninterpretableRows(name: string, refusal: Extract<CheckRowConversion, { ok: false }>): string {
  const value = typeof refusal.value === 'string' ? JSON.stringify(refusal.value) : renderValue(refusal.value);
  const noun = refusal.rowsSelected === 1 ? 'row' : 'rows';
  return `The check "${name}" ran and selected ${String(refusal.rowsSelected)} ${noun}, but row`
    + ` ${String(refusal.row)}'s ${refusal.field} = ${value} ${refusal.reason}, so none of its rows were reported.`;
}

/**
 * A row's evidence: every column but the reserved ones, in the order SQLite
 * returned them, each value through {@link evidenceValue}.
 *
 * @param row - One selected row
 * @returns The evidence object
 */
function evidenceOf(row: Record<string, unknown>): Record<string, CheckEvidenceValue> {
  const evidence: Record<string, CheckEvidenceValue> = {};
  for (const [column, value] of Object.entries(row)) {
    if (!isReserved(column)) evidence[column] = evidenceValue(value);
  }
  return evidence;
}

/**
 * Whether a column name is one of {@link CHECK_FINDING_COLUMNS}, exactly.
 *
 * @param column - The column as the statement spelled it
 * @returns True for a reserved name
 */
function isReserved(column: string): column is ReservedCheckColumn {
  return (CHECK_FINDING_COLUMNS as readonly string[]).includes(column);
}

/**
 * One evidence value: as SQLite returned it when JSON can carry it, else the
 * message's own rendering ({@link renderValue}) — one renderer, so the
 * evidence and the message never disagree about a BLOB.
 *
 * @param value - Whatever SQLite returned for the column
 * @returns The value, or its text
 */
function evidenceValue(value: unknown): CheckEvidenceValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return renderValue(value);
}

/** A row's strict reserved columns, read — or the first one that cannot be. */
type RowReading =
  | { readonly ok: true; readonly severity: Severity | undefined; readonly line: number | undefined; readonly column: number | undefined }
  | { readonly ok: false; readonly field: StrictCheckColumn; readonly reason: string };

/**
 * Read one row's `finding_severity`, `finding_line` and `finding_column`.
 *
 * @param row - One selected row
 * @returns The three values, or the column that refused
 */
function readRow(row: Record<string, unknown>): RowReading {
  const severity = readSeverity(row['finding_severity']);
  if (!severity.ok) return { ok: false, field: 'finding_severity', reason: SEVERITY_REFUSAL };
  const line = readPosition(row['finding_line']);
  if (!line.ok) return { ok: false, field: 'finding_line', reason: POSITION_REFUSAL };
  const column = readPosition(row['finding_column']);
  if (!column.ok) return { ok: false, field: 'finding_column', reason: POSITION_REFUSAL };
  // A column is a place WITHIN a line; on its own it places nothing.
  if (column.value !== undefined && line.value === undefined) {
    return { ok: false, field: 'finding_column', reason: 'is set but its line is not' };
  }
  return { ok: true, severity: severity.value, line: line.value, column: column.value };
}

/**
 * The `finding_severity` column: exactly a {@link Severity}, case-sensitive.
 *
 * ⛔ `'ignore'` is refused: it is an adopter's override, never a fact a row can
 * state about itself — a row that could ignore itself is a check that passes by
 * writing its own exemption.
 *
 * @param value - The column's value
 * @returns The severity, nothing, or a refusal
 */
function readSeverity(value: unknown): Read<Severity> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const parsed = SeveritySchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * The `finding_line` or `finding_column` column: a positive safe integer.
 *
 * A `bigint` is accepted in range, because a store that reads 64-bit integers
 * as `bigint` returns one for an ordinary `INTEGER` column.
 *
 * @param value - The column's value
 * @returns The position, nothing, or a refusal
 */
function readPosition(value: unknown): Read<number> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { ok: true, value };
  if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: true, value: Number(value) };
  }
  return { ok: false };
}

/**
 * The selected columns whose names match a reserved one in another case.
 *
 * @param row - Any one row: every row of one statement has the same columns
 * @returns The near misses, in the order the statement selected them
 */
function nearMissesOf(row: Record<string, unknown> | undefined): NearMiss[] {
  if (row === undefined) return [];
  const misses: NearMiss[] = [];
  for (const column of Object.keys(row)) {
    const reserved = CHECK_FINDING_COLUMNS.find((name) => name === column.toLowerCase());
    if (reserved !== undefined && reserved !== column) misses.push({ column, reserved });
  }
  return misses;
}

/**
 * The file a row points at, when it points at one.
 *
 * A **convention**, deliberately: a check that selects a `path` column gets
 * findings a reader can open, and one that does not — an aggregate, a count —
 * gets a finding with no location rather than a fabricated one. Anchoring every
 * finding to the config file instead would put the reader where the check is
 * WRITTEN, which is never where the problem is.
 *
 * 🪤 What makes a value USABLE as a location — relative, POSIX, non-empty — is
 * {@link findingLocation}, shared with the built-in check set for the reason its
 * module header gives: two lanes materialise findings from projection rows, and
 * nothing downstream re-validates either lane's `location`, so a second copy of
 * the guard is one of them silently losing a clause.
 *
 * @param row - One selected row
 * @returns The location, or undefined when the row names no usable one
 */
function locationOf(row: Record<string, unknown>): string | undefined {
  return findingLocation(row['path']);
}

/**
 * Render a row as evidence.
 *
 * Every selected column, in the order SQLite returned it. This is what makes two
 * violations of one check distinguishable — a message that repeated only the
 * description would name the rule and never the instance.
 *
 * 🪤 `null` renders as `null` rather than being skipped. The projection uses it
 * meaningfully (`contentKey` is null for a deliberately unread row), so dropping
 * it would make "this column was null" and "this column was not selected" the
 * same text.
 *
 * @param row - One selected row
 * @returns `col=value` pairs, comma-separated
 */
function renderRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([column, value]) => `${column}=${renderValue(value)}`)
    .join(', ');
}

/**
 * One column's value, as short readable text.
 *
 * @param value - Whatever SQLite returned for the column
 * @returns Its rendering
 */
function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  // Anything else is a `Uint8Array` from a BLOB column, which is the only other
  // shape `node:sqlite` returns. `String()` on it would give the reader
  // `[object Uint8Array]`, so it goes through JSON — and the `??` covers the one
  // input `JSON.stringify` answers `undefined` for.
  return JSON.stringify(value) ?? '[unserializable]';
}
