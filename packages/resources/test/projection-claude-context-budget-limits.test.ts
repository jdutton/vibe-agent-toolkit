/**
 * The budget's stated limits: a COMPOSED subset of the query's list, plus the
 * four bounds that exist only because a threshold is being applied.
 *
 * ## Why the composition is the thing under test
 *
 * `ALWAYS_LOADED_BUDGET_LIMITS` is not authored — it is SELECTED from
 * `CLAUDE_CONTEXT_LIMITS` by id and then extended. Two failure modes follow from
 * that, and neither is visible in a diff:
 *
 * - A renamed id in the source list silently drops a bound. `limitsById` throws
 *   on an unknown id precisely so that becomes a loud failure, and the first test
 *   below is what keeps the throw from being deleted as "defensive".
 * - An id creeping in from the excluded half publishes a caveat about
 *   path-scoped rule classification to a report that charges no path-scoped rule
 *   — noise that dilutes the bounds a reader does have to act on.
 *
 * ⛔ Assertions are BY ID, never by index, and the length assertion beside them
 * is a CHANGE DETECTOR rather than a claim of completeness — the same division of
 * labour the `CLAUDE_CONTEXT_LIMITS` suite documents.
 */

import { describe, expect, it } from 'vitest';

import {
  ALWAYS_LOADED_BUDGET_LIMITS,
  BUDGET_LIMIT_IDS_FROM_CONTEXT,
  limitsById,
} from '../src/projection/claude-context-budget-limits.js';
import { CLAUDE_CONTEXT_LIMITS } from '../src/projection/claude-context-limits.js';

/** The four signs, named once each — the ids below are named once each too. */
const UNDER_REPORT = 'under-report';
const SCOPE = 'scope';
const ASSUMPTION = 'assumption';

/** Every `direction` a {@link StatedLimit} may carry. */
const DIRECTIONS = new Set(['over-report', UNDER_REPORT, SCOPE, ASSUMPTION]);

/** Ids this file names more than once, so the literal lives in one place. */
const EXCLUDES = 'claude-md-excludes';
const TOKEN_ESTIMATE = 'token-estimate';
const IMPORT_HOP = 'import-hop-calibration';
const UNATTRIBUTED = 'unattributed-imports-counted';
const AUTO_MEMORY = 'auto-memory';
const PATH_SCOPED = 'path-scoped-rules-excluded';
const PROVENANCE = 'threshold-provenance';

/**
 * The ids selected from the query's list, restated here rather than imported.
 *
 * ⛔ Deliberately a second copy. Importing the module's own selection and
 * asserting it equals itself is the vacuous test this file exists to avoid; a
 * hand-written list is what makes an unreviewed addition or removal fail here.
 */
const EXPECTED_FROM_CONTEXT = [
  EXCLUDES,
  'setting-sources',
  'html-comments',
  AUTO_MEMORY,
  'managed-claude-md-key',
  'user-and-managed-scope',
  'add-dir',
  'unresolved-conditions-collapse',
  'variable-imports-unfollowed',
  'gitignored-not-realized',
  'main-conversation-only',
  'version-gated',
  'outside-root-is-not-external',
  'context-window-scope',
  'cliff-scope',
  TOKEN_ESTIMATE,
];

/**
 * The ids deliberately left behind, each about something this budget never
 * charges: path-scoped rule classification, or the discoverable set.
 */
const EXPECTED_EXCLUDED = [
  'glob-dialect',
  'directory-glob',
  'existential-needs-a-file',
  'discovery-one-hop',
  'root-claude-md-order',
  'dot-matching',
  'nested-rule-trigger',
];

/** The bounds that exist only because a THRESHOLD is applied to the measurement. */
const EXPECTED_BUDGET_SPECIFIC = [
  IMPORT_HOP,
  UNATTRIBUTED,
  PATH_SCOPED,
  PROVENANCE,
];

describe('limitsById', () => {
  it('THROWS on an unknown id rather than silently dropping the bound', () => {
    expect(() => limitsById([EXCLUDES, 'no-such-limit'])).toThrow(/no-such-limit/);
  });

  it('names the module a reader has to open to fix the rename', () => {
    expect(() => limitsById(['no-such-limit'])).toThrow(/CLAUDE_CONTEXT_LIMITS/);
  });

  it('returns the entries themselves, in the order asked for', () => {
    const selected = limitsById([TOKEN_ESTIMATE, AUTO_MEMORY]);

    expect(selected.map((limit) => limit.id)).toEqual([TOKEN_ESTIMATE, AUTO_MEMORY]);
    expect(selected[0]).toBe(CLAUDE_CONTEXT_LIMITS.find((limit) => limit.id === TOKEN_ESTIMATE));
  });
});

describe('ALWAYS_LOADED_BUDGET_LIMITS', () => {
  it('publishes exactly the selected subset plus the budget-specific block', () => {
    const ids = ALWAYS_LOADED_BUDGET_LIMITS.map((limit) => limit.id);

    // The change detector. It fails on any growth or shrink, including the
    // reuse-one-slot-for-another-bound edit a by-id check alone would pass.
    expect(ALWAYS_LOADED_BUDGET_LIMITS).toHaveLength(
      EXPECTED_FROM_CONTEXT.length + EXPECTED_BUDGET_SPECIFIC.length,
    );
    expect(ids).toEqual([...EXPECTED_FROM_CONTEXT, ...EXPECTED_BUDGET_SPECIFIC]);
  });

  it('carries every id the module declares it selects', () => {
    expect([...BUDGET_LIMIT_IDS_FROM_CONTEXT]).toEqual(EXPECTED_FROM_CONTEXT);
  });

  it('carries NONE of the path-scoped or discovery bounds', () => {
    const ids = new Set(ALWAYS_LOADED_BUDGET_LIMITS.map((limit) => limit.id));

    for (const excluded of EXPECTED_EXCLUDED) {
      expect(ids.has(excluded)).toBe(false);
    }
  });

  it('accounts for all 23 published context limits, in or out', () => {
    // Neither list may quietly forget an entry: a new limit added upstream has
    // to be ruled in or ruled out, and this is where the omission surfaces.
    const ruled = new Set([...EXPECTED_FROM_CONTEXT, ...EXPECTED_EXCLUDED]);

    expect(CLAUDE_CONTEXT_LIMITS.map((limit) => limit.id).filter((id) => !ruled.has(id))).toEqual([]);
    expect(ruled.size).toBe(CLAUDE_CONTEXT_LIMITS.length);
  });

  it('gives every entry a signed direction and a statement a reader can act on', () => {
    for (const limit of ALWAYS_LOADED_BUDGET_LIMITS) {
      expect(DIRECTIONS.has(limit.direction)).toBe(true);
      expect(limit.statement.trim().length).toBeGreaterThan(0);
    }
  });

  it('signs the four budget-specific bounds the way the threshold argument needs', () => {
    const directionOf = (id: string): string | undefined =>
      ALWAYS_LOADED_BUDGET_LIMITS.find((limit) => limit.id === id)?.direction;

    expect(directionOf(IMPORT_HOP)).toBe(UNDER_REPORT);
    expect(directionOf(UNATTRIBUTED)).toBe(UNDER_REPORT);
    expect(directionOf(PATH_SCOPED)).toBe(SCOPE);
    expect(directionOf(PROVENANCE)).toBe(ASSUMPTION);
  });

  it('says an UNSCOPED root rule IS charged, not that every rule is excluded', () => {
    const scoped = ALWAYS_LOADED_BUDGET_LIMITS.find((limit) => limit.id === PATH_SCOPED);

    expect(scoped?.statement).toMatch(/unscoped rule/i);
    expect(scoped?.statement).toMatch(/is charged|are charged/i);
  });

  it('cites the module carrying the calibration rather than restating percentiles', () => {
    const provenance = ALWAYS_LOADED_BUDGET_LIMITS.find((limit) => limit.id === PROVENANCE);

    expect(provenance?.statement).toContain('claude-context-budget.ts');
    // The percentile figures live in exactly one place and are re-measured
    // there; a copy here would rot the moment that module is re-run.
    expect(provenance?.statement).not.toMatch(/p71|p82|p100/);
  });

  it('has no duplicate ids', () => {
    const ids = ALWAYS_LOADED_BUDGET_LIMITS.map((limit) => limit.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
