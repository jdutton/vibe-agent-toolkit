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
 * A `resources.validation.severity` override still reaches it, and safely:
 * `resolveIssueSeverity` only calls `resolveSeverity` for a code the overrides
 * map actually lists, and `resolveSeverity` returns a listed value before it
 * ever indexes `CODE_REGISTRY`. So an adopter can downgrade or ignore a check
 * they inherited without editing the check. The declaration is the default, not
 * a ceiling.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { ResourceCheck } from '../schemas/project-config.js';

/**
 * What a check's code is prefixed with.
 *
 * Exported so the CLI and any consumer filtering findings can test for a custom
 * code without restating the literal — the two spaces must stay disjoint, and a
 * second copy of `'CUSTOM:'` is how that stops being true.
 */
export const CUSTOM_CODE_PREFIX = 'CUSTOM:';

/**
 * The validation code one named check's findings carry.
 *
 * @param name - The check's key in `resources.checks`
 * @returns The namespaced code
 */
export function customCheckCode(name: string): `${typeof CUSTOM_CODE_PREFIX}${string}` {
  return `${CUSTOM_CODE_PREFIX}${name}`;
}

/**
 * Turn one check's selected rows into findings.
 *
 * @param name - The check's key in `resources.checks`
 * @param check - Its declaration
 * @param rows - Exactly what the statement returned — undecoded, as SQLite holds
 *   it. See `SqlQueryableStore.query`: arbitrary SQL has no table spec, so a
 *   boolean arrives as `0`/`1` and a date as text. The message renders what is
 *   there rather than pretending otherwise
 * @returns One finding per row, in the order SQLite produced them
 */
export function issuesFromCheckRows(
  name: string,
  check: ResourceCheck,
  rows: readonly Record<string, unknown>[],
): ValidationIssue[] {
  return rows.map((row) => {
    const location = locationOf(row);
    return {
      code: customCheckCode(name),
      // Declared, defaulting to `error`. The safe direction: a check whose
      // author did not think about severity is still an assertion they wanted
      // enforced, and defaulting to `warning` would let it pass CI in silence —
      // which is the exact outcome writing a check was meant to prevent.
      severity: check.severity ?? 'error',
      message: `${check.description} — ${renderRow(row)}`,
      // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
      // an absent key and one holding `undefined` different values, and
      // `ValidationIssue.location` is refined: it must be a project-relative
      // POSIX path or absent. There is no third state to put a placeholder in.
      ...(location === undefined ? {} : { location }),
    };
  });
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
 * 🪤 Absolute and backslashed values are declined rather than passed through.
 * `ValidationIssueSchema` refines `location` to a relative POSIX path and would
 * reject them at the boundary; declining here means a check that selected an
 * absolute path loses its anchor instead of failing the whole run. Every
 * projection table stores root-relative POSIX paths, so this only fires on a
 * statement that built one itself.
 *
 * @param row - One selected row
 * @returns The location, or undefined when the row names no usable one
 */
function locationOf(row: Record<string, unknown>): string | undefined {
  const value = row['path'];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.includes('\\')) return undefined;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return undefined;
  return value;
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
