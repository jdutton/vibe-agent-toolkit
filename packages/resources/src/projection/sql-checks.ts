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
 * `packages/schema/src/validation-config.ts` is the shipped registry enum
 * unioned with one refinement, `isCustomCheckCode`, so `CUSTOM:<name>` parses as
 * a `severity` key while a misspelled REGISTRY code is still refused. Resolution
 * is safe on the same key: `resolveIssueSeverity` calls `resolveSeverity` only
 * for a code the overrides map actually lists, and `resolveSeverity` returns a
 * listed value before it ever indexes `CODE_REGISTRY`. So an adopter downgrades
 * or ignores a check they inherited without editing it — the declaration is the
 * default, not a ceiling.
 *
 * ⚠️ **The override reaches VIOLATIONS only.** A check that cannot run — a
 * renamed column, a table that is gone — is not reported under this code space
 * at all: `vat resources check` emits `RESOURCE_CHECK_BROKEN` at `error`. That
 * code is in `NonOverridableCode` in
 * `packages/schema/src/validation-codes.ts` and deliberately **absent from
 * `CODE_REGISTRY`**, so `ValidationConfigSchema` refuses it as a `severity` key
 * outright — unsilenceable by construction rather than by convention. The two
 * used to share `CUSTOM:<name>`, which meant the documented way to stand down an
 * inherited check also silenced the news that it had stopped checking, and a
 * renamed projection column produced exit 0 from a gate. Downgrade the check as
 * far as you like; you cannot downgrade the report that it stopped asserting.
 */

import { customCheckCode } from '@vibe-agent-toolkit/schema';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { ResourceCheck } from '../schemas/project-config.js';

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
 * 🪤 Absolute and backslashed values are declined rather than passed through,
 * and **this function is the only thing enforcing that** on this path. Nothing
 * between here and the output formats parses a check's findings through
 * `ValidationIssueSchema`: the CLI's `resources check` hands these issues
 * straight to the severity counts, so there is no validating boundary
 * downstream to fall back on. Deleting a guard would emit an issue that violates
 * `ValidationIssueSchema`'s refined `location` (relative, POSIX) with no gate
 * catching it, and `validation.allow` globs are matched against `location`, so
 * such a value would also silently match no allow entry an adopter wrote. Every
 * projection table stores root-relative POSIX paths, so this only fires on a
 * statement that built one itself.
 *
 * 📌 A path naming a **DIRECTORY** keeps its anchor. Decided rather than
 * overlooked: this module holds no SQL and never opens a database, so it cannot
 * tell `docs` (a directory row) from `docs` (an extension-less file), and
 * refusing every extension-less path would unanchor legitimate file rows —
 * `LICENSE`, `Makefile` — to catch a rarer one. The consequence an adopter has
 * to know is that `validation.allow` globs match against `location`, and
 * `docs/**` does not match the bare directory `docs`; allow the directory itself
 * when a check selects directory rows.
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
