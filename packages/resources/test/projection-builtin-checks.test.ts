/**
 * The built-in check set — VAT's own default assertions over the projection's
 * row model, with no SQL and no database.
 *
 * ## Why these are rows and not a fixture tree
 *
 * A built-in is a pure predicate over `Projection` rows, so a case supplies the
 * rows it is about. That is not merely convenient: the producer that populates
 * `claude_rule_patterns` is a separate change, and a suite that waited for it
 * would pin the PRODUCER's behaviour while claiming to pin the check's. Rows in,
 * findings out, and the two lanes stay independently falsifiable.
 *
 * ## ⭐ The case that carries the design: `unevaluated` emits NOTHING
 *
 * `status` has three values and only ONE of them is a defect. `unevaluated` is
 * VAT declining to run a matcher (a rule whose `paths:` list blew the vendor's
 * expansion budget), and reporting a refusal as a dead glob would report VAT's
 * own declined work as the adopter's bug — the *"a guard that returns the
 * reassuring value"* shape, arriving from the other side. Widen the predicate to
 * `status !== 'matched'` and the case below reds; that mutation was run.
 */

import { describe, expect, it } from 'vitest';

import {
  bindBuiltinChecks,
  BUILTIN_CHECKS,
  CLAUDE_RULE_FRONTMATTER_INVALID_CHECK,
  CLAUDE_RULE_GLOB_INERT_CHECK,
  type BuiltinCheckInput,
} from '../src/projection/builtin-checks.js';
import type { ClaudeRulePatternRow } from '../src/schemas/projection-claude-rules.js';

/** The rules file every case below declares its patterns in. */
const RULES_FILE = '.claude/rules/demo.md';
const RULES_ID = 'res-rules';

/** A pattern row, with only the fields a case cares about spelled out. */
function pattern(overrides: Partial<ClaudeRulePatternRow> = {}): ClaudeRulePatternRow {
  return {
    resourceId: RULES_ID,
    ordinal: 0,
    pattern: 'packages/**/*.ts',
    literalPrefix: 'packages',
    witnessPath: null,
    status: 'inert',
    ...overrides,
  };
}

/** The projection slice a built-in reads, with one rules file realized. */
function input(patterns: readonly ClaudeRulePatternRow[]): BuiltinCheckInput {
  return {
    claudeRulePatterns: patterns,
    resourceRealizations: [{ resourceId: RULES_ID, path: RULES_FILE, contentKey: null }],
    resourceTags: [],
    blobs: [],
  };
}

/** What the inert check reports over these patterns. */
function findingsFor(patterns: readonly ClaudeRulePatternRow[]): ReturnType<
  typeof CLAUDE_RULE_GLOB_INERT_CHECK.run
> {
  return CLAUDE_RULE_GLOB_INERT_CHECK.run(input(patterns));
}

describe('the built-in check registry', () => {
  it('ships the inert-glob check under a name --check can select', () => {
    // The name is the operator's handle: it is what `--check <name>` takes and
    // what the document's `checks[]` publishes, so it is part of the contract
    // rather than an implementation detail.
    expect(BUILTIN_CHECKS.map((check) => check.name))
      .toStrictEqual(['claude-rule-glob-inert', 'claude-rule-frontmatter-invalid']);
    expect(CLAUDE_RULE_GLOB_INERT_CHECK.description.length).toBeGreaterThan(20);
    expect(CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.description.length).toBeGreaterThan(20);
  });

  it('binds each built-in to one projection, so the runner never sees the rows', () => {
    // 🔑 The CLI must stay dumb: it runs a thunk and prices it. Binding here is
    // what keeps the row model out of the command module entirely.
    const bound = bindBuiltinChecks(input([pattern()]));

    expect(bound.map((check) => check.name))
      .toStrictEqual(['claude-rule-glob-inert', 'claude-rule-frontmatter-invalid']);
    expect(bound[0]?.run()).toHaveLength(1);
  });
});

describe('CLAUDE_RULE_GLOB_INERT — one finding per dead glob', () => {
  it('reports an inert pattern at the registry default severity, naming file and glob', () => {
    const [issue, ...rest] = findingsFor([pattern({ pattern: 'apps/**/*.tsx', ordinal: 2 })]);

    expect(rest).toStrictEqual([]);
    expect(issue?.code).toBe('CLAUDE_RULE_GLOB_INERT');
    // 🔑 `info`, and it comes from CODE_REGISTRY rather than from a literal
    // here: a built-in is an ordinary registry code, not a `CUSTOM:` check whose
    // severity is declared beside it.
    expect(issue?.severity).toBe('info');
    // The file a reader opens...
    expect(issue?.location).toBe(RULES_FILE);
    // ...the slot within its own `paths:` list...
    expect(issue?.field).toBe('paths[2]');
    // ...and the dead glob VERBATIM. A message that paraphrased it would leave
    // the reader grepping for a pattern that is not written anywhere.
    expect(issue?.message).toContain('"apps/**/*.tsx"');
    expect(issue?.message).toContain(RULES_FILE);
  });

  it('reports EVERY inert pattern, not just the first of a file', () => {
    // Per the code's own documentation: reported per inert PATTERN, so a rule
    // whose other globs still match is reported only for the dead one — and a
    // rule with two dead globs is reported twice.
    const issues = findingsFor([
      pattern({ ordinal: 0, pattern: 'gone/**' }),
      pattern({ ordinal: 1, pattern: 'also-gone/**' }),
    ]);

    expect(issues.map((issue) => issue.field)).toStrictEqual(['paths[0]', 'paths[1]']);
    expect(issues.map((issue) => issue.message.includes('also-gone/**')))
      .toStrictEqual([false, true]);
  });

  it('says NOTHING about a matched pattern', () => {
    // The control. Without it this suite would pass on a predicate that reports
    // every row, which is the loudest possible way to be wrong.
    expect(findingsFor([pattern({ status: 'matched', witnessPath: 'packages/a/src/x.ts' })]))
      .toStrictEqual([]);
  });

  it('⭐ says NOTHING about an UNEVALUATED pattern — a refusal is not a defect', () => {
    // 🔑 The mutation guard, and the reason `status` has three values instead of
    // a nullable witness. An over-budget rule's null witness records that NOBODY
    // ASKED, not that the glob is dead; `status !== 'matched'` would report
    // VAT's own declined work as the adopter's typo, and there is no edit to a
    // rules file that would fix it.
    expect(findingsFor([pattern({ status: 'unevaluated' })])).toStrictEqual([]);
    // And it is genuinely distinguishable at this seam: the two differ ONLY in
    // the status column, so a predicate that reads the witness instead cannot
    // pass this pair.
    expect(findingsFor([pattern({ status: 'inert' })])).toHaveLength(1);
  });

  it('⭐ says NOTHING about a GITIGNORED pattern — VAT cannot see what the harness can', () => {
    // A glob scoped to `dist/**` matches no file VAT realizes, and the harness
    // reads the filesystem. Reporting it would have the author delete a glob
    // that fires. The pair differs only in the status column.
    expect(findingsFor([pattern({ status: 'gitignored' })])).toStrictEqual([]);
    expect(findingsFor([pattern({ status: 'inert' })])).toHaveLength(1);
  });

  it('says nothing at all when the table is empty', () => {
    // The state of every projection until the producer lands, and the state of a
    // healthy repository afterwards. An empty table is a pass, never a refusal:
    // "this tree declares no path-scoped rules" is not a defect, and the RUN's
    // integrity is asserted by `checksRun` and `examined`, not by this check.
    expect(findingsFor([])).toStrictEqual([]);
  });

  it('still reports a glob whose rules file has no realization, without a location', () => {
    // 🪤 The join is a LEFT join on purpose. A finding with no anchor is worse
    // than one with an anchor; a finding DROPPED because a join missed is worse
    // than both, because the count then silently disagrees with the table and
    // nothing says so.
    const orphan = { ...input([pattern({ resourceId: 'res-unknown' })]), resourceRealizations: [] };

    const [issue] = CLAUDE_RULE_GLOB_INERT_CHECK.run(orphan);
    expect(issue?.code).toBe('CLAUDE_RULE_GLOB_INERT');
    expect(issue?.location).toBeUndefined();
    expect(Object.hasOwn(issue ?? {}, 'location')).toBe(false);
  });

  it('declines an unusable path rather than emitting a location the schema refuses', () => {
    // 🪤 Nothing between here and the output formats parses these findings
    // through `ValidationIssueSchema`, so this function is the only thing
    // keeping `location` project-relative and POSIX — the same guarantee
    // `sql-checks.ts` rests on, which is why both call one predicate.
    const absolute = {
      ...input([pattern()]),
      resourceRealizations: [{ resourceId: RULES_ID, path: '/etc/rules.md', contentKey: null }],
    };

    expect(CLAUDE_RULE_GLOB_INERT_CHECK.run(absolute)[0]?.location).toBeUndefined();
  });
});

/** The key the broken rules file's blob is filed under. */
const BROKEN_KEY = 'markdown.broken';
/** What the YAML parser said about it — content, never a path. */
const YAML_ERROR = 'Unresolved alias (the anchor must be set before the alias): */x/*.ts';

/**
 * A tree with one rules file whose frontmatter did not parse, realized under two
 * extents (the ordinary state), plus a NON-rules markdown file with the same
 * defect — which is `vat resources validate`'s business, not this check's.
 *
 * @param overrides - Fields to replace
 * @returns The input
 */
function brokenRuleInput(overrides: Partial<BuiltinCheckInput> = {}): BuiltinCheckInput {
  return {
    claudeRulePatterns: [],
    resourceRealizations: [
      { resourceId: RULES_ID, path: RULES_FILE, contentKey: BROKEN_KEY },
      { resourceId: RULES_ID, path: RULES_FILE, contentKey: BROKEN_KEY },
      { resourceId: 'res-doc', path: 'docs/readme.md', contentKey: BROKEN_KEY },
    ],
    resourceTags: [{ resourceId: RULES_ID, tag: 'rules-file' }],
    blobs: [{ contentKey: BROKEN_KEY, frontmatterError: YAML_ERROR }],
    ...overrides,
  };
}

describe('CLAUDE_RULE_FRONTMATTER_INVALID — a rules file whose frontmatter does not parse', () => {
  it('reports it ONCE per rules file, at the file, carrying the parser reason', () => {
    const [issue, ...rest] = CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput());

    // One finding for two realizations, and none for the non-rules file.
    expect(rest).toStrictEqual([]);
    expect(issue?.code).toBe('CLAUDE_RULE_FRONTMATTER_INVALID');
    // From CODE_REGISTRY, not a literal: an ordinary, overridable code.
    expect(issue?.severity).toBe('warning');
    expect(issue?.location).toBe(RULES_FILE);
    expect(issue?.field).toBe('frontmatter');
    expect(issue?.message).toContain(YAML_ERROR);
    // Why it matters is in the message: the globs never reached the pattern table.
    expect(issue?.message).toContain('claude_rule_patterns');
  });

  it('says NOTHING about a rules file whose frontmatter parsed', () => {
    // The control: the same tree with the error cleared reports nothing, so the
    // finding above is about the error column and not about the tag alone.
    expect(CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput({
      blobs: [{ contentKey: BROKEN_KEY, frontmatterError: null }],
    }))).toStrictEqual([]);
  });

  it('says NOTHING about a non-rules file with the same defect', () => {
    expect(CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput({ resourceTags: [] })))
      .toStrictEqual([]);
  });

  it('says nothing about a rules file that was never keyed', () => {
    // No bytes were read, so nothing was parsed: no verdict to report.
    expect(CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput({
      resourceRealizations: [{ resourceId: RULES_ID, path: RULES_FILE, contentKey: null }],
    }))).toStrictEqual([]);
  });

  it('says a ROOT rule loads at launch and a NESTED one on demand', () => {
    const nested = 'sub/.claude/rules/x.md';
    const [rootIssue] = CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput());
    const [nestedIssue] = CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput({
      resourceRealizations: [{ resourceId: RULES_ID, path: nested, contentKey: BROKEN_KEY }],
    }));

    expect(rootIssue?.message).toContain('loaded at launch');
    expect(nestedIssue?.message).toContain("loaded on demand, when Claude reads files under 'sub'");
    expect(nestedIssue?.message).not.toContain('at launch');
  });

  it('keeps only the first line of a multi-line parser message', () => {
    const [issue] = CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput({
      blobs: [{ contentKey: BROKEN_KEY, frontmatterError: `${YAML_ERROR}\n\n  1 | paths:\n    ^` }],
    }));

    expect(issue?.message).toContain(YAML_ERROR);
    expect(issue?.message).not.toContain('1 | paths:');
  });
});
