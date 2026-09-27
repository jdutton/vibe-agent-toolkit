/**
 * The ONE reader of the content-keyed harness tables (`harness_blob_facts`,
 * `harness_blob_imports`) — and the reason it exists is that an absent facts
 * row must never read as zero.
 *
 * The facts are a DERIVED answer per `(blob, harness)`. A blob with no row has
 * not been derived for that harness, which is a different fact from "injects
 * nothing": coercing the absence to `0`, `null` or `[]` would charge a real
 * memory file nothing, scope a path-scoped rule by nothing (so it loads
 * everywhere) and follow none of its imports — every one of them a plausible,
 * silent, wrong answer. So the absence is `undefined` in {@link
 * HarnessFactsIndex.factsOf}, and a {@link HarnessFactsAbsentError} everywhere
 * the caller already knows the harness reached the blob.
 *
 * Only type imports from this package, deliberately: `claude-rules-scope.ts`
 * reads this module, and it sits on the `claude-code.ts → claude-memory.ts →
 * claude-context-rules.ts` import chain, so a runtime dependency on the harness
 * profiles here would close a cycle.
 */

import { VatError } from '@vibe-agent-toolkit/utils';

import type { HarnessBlobFactsRow, HarnessBlobImportRow } from '../../schemas/projection-harness.js';

import type { HarnessId } from './profile.js';

/** The `code` a {@link HarnessFactsAbsentError} carries — dispatch on this, never on the message. */
export const HARNESS_FACTS_ABSENT = 'HARNESS_FACTS_ABSENT';

/**
 * A blob the harness reached has no facts row for that harness — a producer
 * bug, never a property of the corpus. A command that meets one could not do
 * its job (exit 2). Recognise it with `isVatError(error,
 * HarnessFactsAbsentError.code)`, never by message.
 */
export class HarnessFactsAbsentError extends VatError {
  /** The code every instance carries. */
  static readonly code = HARNESS_FACTS_ABSENT;

  /**
   * @param harness - The harness whose facts are missing
   * @param contentKey - The blob that has none
   * @param path - The root-relative path the blob was reached at, or null when
   *   the caller holds only the blob
   */
  constructor(
    readonly harness: HarnessId,
    readonly contentKey: string,
    readonly path: string | null,
  ) {
    super(
      HARNESS_FACTS_ABSENT,
      `No ${harness} facts were derived for blob ${contentKey}`
        + (path === null ? '' : ` (reached at ${path})`)
        + ' — the harness reached it, so its facts must exist. This is a VAT bug.',
    );
  }
}

/** The two harness tables, as any projection-shaped object carries them. */
export interface HarnessFactsView {
  readonly harnessBlobFacts: readonly HarnessBlobFactsRow[];
  readonly harnessBlobImports: readonly HarnessBlobImportRow[];
}

/** One harness's facts, by blob. */
export interface HarnessFactsIndex {
  /** undefined = not derived. NEVER coerce to 0/null/[] — that is the bug this module exists to stop. */
  factsOf(contentKey: string): HarnessBlobFactsRow | undefined;
  /** Throws HarnessFactsAbsentError. Use wherever the caller already knows the harness reached the blob. */
  requireFacts(contentKey: string, path: string | null): HarnessBlobFactsRow;
  /** Imports of a DERIVED blob, in ordinal order; throws HarnessFactsAbsentError when the blob has no facts row. */
  requireImports(contentKey: string, path: string | null): readonly HarnessBlobImportRow[];
  /** Every import row of this harness, in table order — for a reader that wants the whole table, never per blob. */
  imports(): readonly HarnessBlobImportRow[];
}

/**
 * One memo entry: an index plus the two row counts that were its whole premise.
 *
 * The counts are READ off the tables the index was derived from — not a
 * version anyone bumps — so a table that grows (a lazy derivation pass adding
 * rows mid-run) rebuilds the index rather than serving a stale absence.
 */
interface MemoizedFactsIndex {
  readonly factsCount: number;
  readonly importsCount: number;
  readonly index: HarnessFactsIndex;
}

const factsIndexMemo = new WeakMap<HarnessFactsView, Map<HarnessId, MemoizedFactsIndex>>();

const NO_IMPORTS: readonly HarnessBlobImportRow[] = Object.freeze([]);

/**
 * One harness's facts index over a view, built once per `(view, row counts)`.
 *
 * @param view - The projection (or builder base) carrying the harness tables
 * @param harness - The harness whose rows to read; other harnesses' rows are ignored
 * @returns The index
 */
export function harnessFactsIndex(view: HarnessFactsView, harness: HarnessId): HarnessFactsIndex {
  let byHarness = factsIndexMemo.get(view);
  if (byHarness === undefined) {
    byHarness = new Map();
    factsIndexMemo.set(view, byHarness);
  }
  const factsCount = view.harnessBlobFacts.length;
  const importsCount = view.harnessBlobImports.length;
  const cached = byHarness.get(harness);
  if (cached?.factsCount === factsCount && cached.importsCount === importsCount) return cached.index;
  const index = buildIndex(view, harness);
  byHarness.set(harness, { factsCount, importsCount, index });
  return index;
}

/**
 * Build one harness's index over a view.
 *
 * @param view - The harness tables
 * @param harness - The harness to read
 * @returns The index
 */
function buildIndex(view: HarnessFactsView, harness: HarnessId): HarnessFactsIndex {
  const facts = new Map<string, HarnessBlobFactsRow>();
  for (const row of view.harnessBlobFacts) {
    if (row.harness === harness) facts.set(row.blob, row);
  }
  const imports = new Map<string, HarnessBlobImportRow[]>();
  const all: HarnessBlobImportRow[] = [];
  for (const row of view.harnessBlobImports) {
    if (row.harness !== harness) continue;
    all.push(row);
    const list = imports.get(row.blob);
    if (list === undefined) {
      imports.set(row.blob, [row]);
    } else {
      list.push(row);
    }
  }
  // Sorted rather than trusted: `ordinal` is the documented order the harness
  // follows a blob's imports in; insertion order is whatever the producer did.
  for (const list of imports.values()) list.sort((left, right) => left.ordinal - right.ordinal);

  const requireFacts = (contentKey: string, path: string | null): HarnessBlobFactsRow => {
    const row = facts.get(contentKey);
    if (row === undefined) throw new HarnessFactsAbsentError(harness, contentKey, path);
    return row;
  };
  return {
    factsOf: (contentKey) => facts.get(contentKey),
    requireFacts,
    requireImports: (contentKey, path) => {
      requireFacts(contentKey, path);
      return imports.get(contentKey) ?? NO_IMPORTS;
    },
    imports: () => all,
  };
}
