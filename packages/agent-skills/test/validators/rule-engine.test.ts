/**
 * Scenario harness for the intent-aware verdict engine (issue #129, slice 3).
 *
 * One table of `{ intent, ctx, expect }` rows drives the REAL `evaluate`
 * engine over constructed `RuleContext`s (no filesystem). The harness enforces
 * three meta-invariants:
 *
 *  1. **Per-row correctness** — `evaluate(ctx) === expect`, and when a code
 *     fires, the materialized issue's description / fix / defaultSeverity equal
 *     the registry (so the engine cannot drift from CODE_REGISTRY).
 *  2. **Aliasing detector** — group rows by serialized `RuleContext`; if one
 *     signature maps to more than one distinct `expect`, the table (or the
 *     RuleContext shape) is ambiguous → fail and name both intents.
 *  3. **Anti-workaround invariant** — every registry `fix` for a skill-resource
 *     code names a sanctioned action BEFORE any "ignore / allow" escape hatch.
 */
import { CODE_REGISTRY, type IssueCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import {
  evaluate,
  makeRuleContext,
  materializeIssue,
  type RuleContext,
} from '../../src/validators/rule-engine/index.js';

interface Scenario {
  /** Human-readable intent — what real-world situation this row models. */
  intent: string;
  ctx: Partial<RuleContext>;
  expect: IssueCode | null;
}

// ---------------------------------------------------------------------------
// The scenario table — one-line deltas off makeRuleContext() defaults.
// ---------------------------------------------------------------------------
const SCENARIOS: Scenario[] = [
  // --- edges: structural exclusions ----------------------------------------
  {
    intent: 'prose link to a file outside the project root',
    ctx: { subject: 'edge', outsideProject: true },
    expect: 'LINK_OUTSIDE_PROJECT',
  },
  {
    // Valid (#126) and REPORTED. The two are not in tension: the directory is a
    // legitimate thing to link to and is never bundled, so the finding is about
    // the packaged link pointing at nothing, at `warning` rather than `error`.
    // This row expected `null` while the code returned `null`, which is exactly
    // what a silence looks like from inside its own test.
    intent: 'navigational prose link resolving to a directory (valid, #126, still reported)',
    ctx: { subject: 'edge', fileKind: 'directory' },
    expect: 'LINK_TO_UNBUNDLED_DIRECTORY',
  },
  {
    intent: 'typed files: source slot resolving to a directory',
    ctx: { subject: 'edge', fileKind: 'directory', typedSingleFileSlot: true },
    expect: 'LINK_TARGETS_DIRECTORY',
  },
  {
    // The target is there; the walker just could not read it. Reported outright
    // rather than skipped, mirroring the resources lane's RESOURCE_UNREADABLE.
    intent: 'edge target exists but is unreadable (unstattable)',
    ctx: { subject: 'edge', unreadable: true },
    expect: 'LINK_TARGET_UNREADABLE',
  },
  {
    intent: "link to another skill's SKILL.md",
    ctx: { subject: 'edge', crossSkillDefinition: true },
    expect: 'LINK_TO_SKILL_DEFINITION',
  },
  {
    intent: 'link to a files:-declared build artifact not yet materialized',
    ctx: { subject: 'edge', existsAtSource: false, inFilesConfig: true },
    expect: 'LINK_DEFERRED_ARTIFACT',
  },
  {
    intent: 'link to an existing gitignored file (leak risk)',
    ctx: { subject: 'edge', gitignored: true, existsAtSource: true },
    expect: 'LINK_TO_GITIGNORED_FILE',
  },
  {
    // Guards the engine's check ordering: an EXISTING files:-declared target must
    // fall through to the gitignored/leak path, NOT report LINK_DEFERRED_ARTIFACT
    // (deferral requires !existsAtSource). If someone hoisted the inFilesConfig
    // check above the existence-dependent branches, this row breaks.
    intent: 'link to an existing gitignored files:-declared target (leak, not deferred)',
    ctx: { subject: 'edge', inFilesConfig: true, gitignored: true, existsAtSource: true },
    expect: 'LINK_TO_GITIGNORED_FILE',
  },
  {
    intent: 'link to a navigation file excluded from the bundle',
    ctx: { subject: 'edge', fileKind: 'nav' },
    expect: 'LINK_TO_NAVIGATION_FILE',
  },
  {
    intent: 'link to a repo-internal agent-instruction file (CLAUDE.md, AGENTS.md, GEMINI.md)',
    ctx: { subject: 'edge', fileKind: 'agent-instruction' },
    expect: 'LINK_TO_AGENT_INSTRUCTION_FILE',
  },
  {
    // Intentional, hence `info` — but a receipt, not a silence. "The author
    // asked for it" argues down the severity; it never argued for emitting
    // nothing, which is what the engine did.
    intent: 'reference excluded by an author-configured pattern (intentional, reported at info)',
    ctx: { subject: 'edge', patternExcluded: true },
    expect: 'LINK_EXCLUDED_BY_PATTERN',
  },
  {
    intent: 'link dropped because it lay beyond linkFollowDepth',
    ctx: { subject: 'edge', droppedByDepth: true },
    expect: 'LINK_DROPPED_BY_DEPTH',
  },
  {
    intent: 'source-time link to a missing target (author error)',
    ctx: { subject: 'edge', phase: 'source', existsAtSource: false },
    expect: 'LINK_MISSING_TARGET',
  },
  {
    intent: 'built-output link to a missing file (link-rewriter bug)',
    ctx: { subject: 'edge', phase: 'built', existsAtSource: false },
    expect: 'PACKAGED_BROKEN_LINK',
  },
  {
    intent: 'ordinary prose link resolving to an existing in-bundle file',
    ctx: { subject: 'edge', fileKind: 'doc', existsAtSource: true, reachableFromSkillMd: true, referencedHow: 'link' },
    expect: null,
  },
  // --- files: orphan candidates --------------------------------------------
  {
    intent: 'unreferenced file in the built output',
    ctx: { subject: 'file', phase: 'built', reachableFromSkillMd: false, referencedHow: 'none', copyRole: 'skill-bundled' },
    expect: 'PACKAGED_UNREFERENCED_FILE',
  },
  {
    intent: 'unreferenced built file that is a plugin artifact (exempt)',
    ctx: { subject: 'file', phase: 'built', reachableFromSkillMd: false, referencedHow: 'none', copyRole: 'plugin-artifact' },
    expect: null,
  },
  {
    intent: 'built file referenced from SKILL.md (not an orphan)',
    ctx: { subject: 'file', phase: 'built', reachableFromSkillMd: true, referencedHow: 'link' },
    expect: null,
  },
  {
    intent: 'built file only documented via a code-block mention (not an orphan)',
    ctx: { subject: 'file', phase: 'built', reachableFromSkillMd: false, referencedHow: 'mention' },
    expect: null,
  },
  {
    intent: 'built file declared in files: config (not an orphan)',
    ctx: { subject: 'file', phase: 'built', reachableFromSkillMd: false, referencedHow: 'none', inFilesConfig: true },
    expect: null,
  },
];

// ---------------------------------------------------------------------------
// Ordering scenarios — contexts where TWO conditions hold at once.
//
// `evaluateEdge`'s docstring says "Ordered: the first matching intent wins",
// and that ordering is load-bearing: it decides which of two applicable codes
// (and therefore which severity) an author is shown. The table above cannot
// pin it. Almost every row there sets a single context flag, so no two
// conditions are ever true together and any permutation of the cascade would
// still pass — the fixture cannot distinguish the orderings it depends on.
//
// Each row below is a context where two branches both match, asserting which
// one wins. Reordering the cascade breaks exactly the pair that moved.
// ---------------------------------------------------------------------------
const ORDERING_SCENARIOS: Scenario[] = [
  {
    // `unreadable` is checked FIRST by design: nothing else about a file that
    // cannot be stat'ed is knowable, so no later branch answers from evidence.
    intent: 'ordering: unreadable target that is ALSO outside the project → unreadable wins',
    ctx: { subject: 'edge', unreadable: true, outsideProject: true },
    expect: 'LINK_TARGET_UNREADABLE',
  },
  {
    intent: 'ordering: directory target that is ALSO outside the project → outside-project wins',
    ctx: { subject: 'edge', outsideProject: true, fileKind: 'directory' },
    expect: 'LINK_OUTSIDE_PROJECT',
  },
  {
    // ⚠️ The consequential one. `fileKind === 'directory'` is checked in
    // `evaluateEdge`; `patternExcluded` only in `evaluateWalkDecision`, below
    // it. So an author who EXPLICITLY excluded this reference via
    // excludeReferencesFromBundle is shown LINK_TO_UNBUNDLED_DIRECTORY
    // (warning) rather than LINK_EXCLUDED_BY_PATTERN (info) — a warning on a
    // configuration they deliberately wrote. Pinned as the behaviour that
    // ships, not endorsed: if LINK_TO_UNBUNDLED_DIRECTORY is ever promoted to
    // `error`, this is the row that says whose build it breaks.
    intent: 'ordering: directory target ALSO excluded by pattern → directory wins over pattern',
    ctx: { subject: 'edge', fileKind: 'directory', patternExcluded: true },
    expect: 'LINK_TO_UNBUNDLED_DIRECTORY',
  },
  {
    // The leak risk outranks the author's exclusion: the pattern says this
    // reference should not be followed, which is not the same as saying the
    // gitignored data behind it is safe to carry.
    intent: 'ordering: gitignored existing target ALSO excluded by pattern → gitignored wins',
    ctx: { subject: 'edge', gitignored: true, existsAtSource: true, patternExcluded: true },
    expect: 'LINK_TO_GITIGNORED_FILE',
  },
  {
    intent: 'ordering: navigation-file target ALSO excluded by pattern → file kind wins',
    ctx: { subject: 'edge', fileKind: 'nav', patternExcluded: true },
    expect: 'LINK_TO_NAVIGATION_FILE',
  },
  {
    intent: 'ordering: pattern-excluded edge ALSO beyond linkFollowDepth → pattern wins',
    ctx: { subject: 'edge', patternExcluded: true, droppedByDepth: true },
    expect: 'LINK_EXCLUDED_BY_PATTERN',
  },
  {
    // Deliberately BELOW the missing-target check, per `evaluateWalkDecision`:
    // a broken link inside an HTML page is an author error with a more
    // actionable code, and reporting the routing boundary instead would send
    // the author to fix VAT's traversal policy over their own typo.
    intent: 'ordering: missing target reached from a non-routable source → missing-target wins',
    ctx: { subject: 'edge', existsAtSource: false, nonRoutableSource: true },
    expect: 'LINK_MISSING_TARGET',
  },
];

/** Both tables drive the same assertions; the split is documentary. */
const ALL_SCENARIOS: Scenario[] = [...SCENARIOS, ...ORDERING_SCENARIOS];

describe('rule-engine: evaluate()', () => {
  it.each(ALL_SCENARIOS)('$intent → $expect', ({ ctx, expect: expected }) => {
    const fullCtx = makeRuleContext(ctx);
    const code = evaluate(fullCtx);
    expect(code).toBe(expected);

    // When a code fires, the materialized issue must equal the registry.
    if (code !== null) {
      const entry = CODE_REGISTRY[code];
      const issue = materializeIssue(code, { location: 'x', detail: 'd' });
      expect(issue.severity).toBe(entry.defaultSeverity);
      expect(issue.fix).toBe(entry.fix);
      expect(issue.reference).toBe(entry.reference);
      // message is the description headline plus dynamic detail
      expect(issue.message).toContain(entry.description);
    }
  });

  it('aliasing detector: no RuleContext signature maps to >1 distinct expected code', () => {
    const bySignature = new Map<string, Map<IssueCode | null, string>>();
    for (const s of SCENARIOS) {
      const sig = JSON.stringify(sortedEntries(makeRuleContext(s.ctx)));
      const existing = bySignature.get(sig) ?? new Map<IssueCode | null, string>();
      existing.set(s.expect, s.intent);
      bySignature.set(sig, existing);
    }
    const collisions = [...bySignature.values()]
      .filter(m => m.size > 1)
      .map(m => [...m.entries()].map(([code, intent]) => `${String(code)} (${intent})`).join(' vs '));
    expect(collisions).toEqual([]);
  });
});

describe('rule-engine: materializeIssue() message construction', () => {
  // A representative code; severity/fix/reference always come from the registry,
  // so the exact code here only matters for sourcing those — the assertions
  // below isolate the three documented message-construction paths.
  const CODE: IssueCode = 'LINK_MISSING_TARGET';
  const entry = CODE_REGISTRY[CODE];

  it('bare description when neither message nor detail is given', () => {
    expect(materializeIssue(CODE).message).toBe(entry.description);
  });

  it('appends detail to the registry description', () => {
    expect(materializeIssue(CODE, { detail: './missing.md' }).message).toBe(
      `${entry.description} (./missing.md)`,
    );
  });

  it('message override takes precedence over detail', () => {
    // The override path is reached in production via createRegistryIssue; assert
    // the documented precedence directly so a regression that drops the override
    // cannot hide behind a substring.
    expect(materializeIssue(CODE, { message: 'bespoke', detail: 'ignored-detail' }).message).toBe(
      'bespoke',
    );
  });

  it('always sources severity / fix / reference from the registry, even with a message override', () => {
    const issue = materializeIssue(CODE, { message: 'bespoke' });
    expect(issue.severity).toBe(entry.defaultSeverity);
    expect(issue.fix).toBe(entry.fix);
    expect(issue.reference).toBe(entry.reference);
  });
});

describe('rule-engine: anti-workaround invariant', () => {
  // Codes whose detection now flows through the engine / shared materializer.
  const ENGINE_CODES: IssueCode[] = [
    'LINK_OUTSIDE_PROJECT',
    'LINK_TARGETS_DIRECTORY',
    'LINK_TO_UNBUNDLED_DIRECTORY',
    'LINK_EXCLUDED_BY_PATTERN',
    'LINK_TO_NAVIGATION_FILE',
    'LINK_TO_GITIGNORED_FILE',
    'LINK_MISSING_TARGET',
    'LINK_TARGET_UNREADABLE',
    'LINK_DEFERRED_ARTIFACT',
    'LINK_TO_SKILL_DEFINITION',
    'LINK_DROPPED_BY_DEPTH',
    'PACKAGED_UNREFERENCED_FILE',
  ];

  // "ignore / allow / severity" escape-hatch language must never lead a fix.
  const ESCAPE_HATCH = /\b(allow|ignore|severity|suppress)\b/i;

  it.each(ENGINE_CODES)('%s fix names a sanctioned action before any escape hatch', (code) => {
    const fix = CODE_REGISTRY[code].fix;
    const firstHatch = fix.search(ESCAPE_HATCH);
    if (firstHatch === -1) {
      // No escape hatch mentioned at all — fine; the whole fix is sanctioned action.
      expect(firstHatch).toBe(-1);
      return;
    }
    // There is sanctioned action text before the first escape-hatch mention.
    const sanctioned = fix.slice(0, firstHatch).trim();
    expect(sanctioned.length).toBeGreaterThan(0);
  });
});

/** Stable, key-sorted entries so signature serialization is order-independent. */
function sortedEntries(ctx: RuleContext): Array<[string, unknown]> {
  return Object.entries(ctx).sort(([a], [b]) => a.localeCompare(b));
}
