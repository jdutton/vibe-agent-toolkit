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
  CLAUDE_RULE_LINK_UNCHECKED_CHECK,
  type BuiltinCheckInput,
} from '../src/projection/builtin-checks.js';
import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
} from '../src/projection/contributors/filesystem-extent.js';
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
    realizationConditions: [],
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
    expect(BUILTIN_CHECKS.map((check) => check.name)).toStrictEqual([
      'claude-rule-glob-inert',
      'claude-rule-frontmatter-invalid',
      'claude-rule-link-unchecked',
    ]);
    for (const check of BUILTIN_CHECKS) expect(check.description.length).toBeGreaterThan(20);
  });

  it('binds each built-in to one projection, so the runner never sees the rows', () => {
    // 🔑 The CLI must stay dumb: it runs a thunk and prices it. Binding here is
    // what keeps the row model out of the command module entirely.
    const bound = bindBuiltinChecks(input([pattern()]));

    expect(bound.map((check) => check.name)).toStrictEqual(BUILTIN_CHECKS.map((check) => check.name));
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
    // ...the frontmatter key, and ONLY the key. `paths[2]` was the old promise
    // and it is unservable: a scalar `paths: "a/**, b/**"` has no YAML sequence
    // to index, and a list entry carrying a comma declares two patterns at one
    // author slot. The ordinal is the dense PATTERN index, so it is spelled in
    // the message in words rather than dressed up as a slot.
    expect(issue?.field).toBe('paths');
    // ...one-based, because a rules author counts globs from one...
    expect(issue?.message).toContain('pattern 3 of');
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

    // ⛔ Not `field` — it is the same constant on both, so asserting it here
    // would pass on a predicate that reported ONE finding twice. The glob is
    // what distinguishes them.
    expect(issues.map((issue) => issue.field)).toStrictEqual(['paths', 'paths']);
    expect(issues.map((issue) => issue.message.includes('also-gone/**')))
      .toStrictEqual([false, true]);
    expect(issues.map((issue) => issue.message.includes('pattern 1 of')))
      .toStrictEqual([true, false]);
  });

  it('⭐ tells a dead NEGATION it has no effect, never that it "matches no file"', () => {
    // ⛔ A `!` pattern matches nothing by construction — its liveness is what
    // it EXCLUDES — so "matches no file" was false for every live negation and
    // misdescribes a dead one. The positive control keeps the old wording.
    const [negation] = findingsFor([pattern({ pattern: '!src/gen.ts', literalPrefix: '' })]);
    expect(negation?.message).toContain('"!src/gen.ts"');
    expect(negation?.message).toContain('excludes no file the rule\'s preceding patterns load');
    expect(negation?.message).toContain('has no effect');
    expect(negation?.message).not.toContain('matches no file');

    const [positive] = findingsFor([pattern()]);
    expect(positive?.message).toContain('matches no file');
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
    realizationConditions: [],
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

  it('⭐ reports frontmatter that PARSED but is not a mapping, in the same lane', () => {
    // `---\n- a\n- b\n---` is valid YAML and decodes to a sequence, so `paths:`
    // cannot be read from it and the rule looks unconditional. `blob-facts.ts`
    // gives the blob that verdict; this check is where it reaches the operator.
    const notMapping = 'the frontmatter block is valid YAML but not a YAML mapping — it decodes'
      + ' to a sequence or a scalar, so it declares no keys at all';
    const [issue] = CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run(brokenRuleInput({
      blobs: [{ contentKey: BROKEN_KEY, frontmatterError: notMapping }],
    }));

    expect(issue?.code).toBe('CLAUDE_RULE_FRONTMATTER_INVALID');
    expect(issue?.message).toContain('not a YAML mapping');
    // The sentence has to survive a reason that is not a parser error: "does
    // not parse (valid YAML …)" would contradict itself.
    expect(issue?.message).not.toContain('does not parse (the frontmatter block is valid YAML');
  });
});

/** A `realization_conditions` row, with only the fields a case cares about. */
function symlinkCondition(path: string, code = EXTENT_SYMLINK_NOT_REALIZED): {
  readonly code: string;
  readonly path: string;
} {
  return { code, path };
}

/**
 * The projection slice the link check reads: condition rows and nothing else.
 *
 * @param conditions - The `realization_conditions` rows
 * @returns The input
 */
function linkInput(
  conditions: readonly { readonly code: string; readonly path: string }[],
): BuiltinCheckInput {
  return { ...input([]), realizationConditions: conditions };
}

describe('CLAUDE_RULE_LINK_UNCHECKED — a rules file VAT can see but cannot check', () => {
  it('reports a symlinked rules FILE, at the link path, naming both blind checks', () => {
    const [issue, ...rest] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules/linked.md')]),
    );

    expect(rest).toStrictEqual([]);
    expect(issue?.code).toBe('CLAUDE_RULE_LINK_UNCHECKED');
    expect(issue?.severity).toBe('warning');
    expect(issue?.location).toBe('.claude/rules/linked.md');
    // The consequence, not the mechanism: both built-ins are structurally blind
    // to this file, and nothing else in the run says so.
    expect(issue?.message).toContain('claude_rule_patterns');
    expect(issue?.message).toContain('frontmatter');
  });

  it('reports a symlinked rules DIRECTORY — every rule beneath it is unchecked', () => {
    const [issue] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules')]),
    );

    expect(issue?.location).toBe('.claude/rules');
    expect(issue?.message).toContain('every rules file');
  });

  it('⭐ reports a link at `.claude` ITSELF — the rules load through it', () => {
    // 🪤 The predicate searched for a `.claude` segment FOLLOWED BY `rules`, and
    // the commonest shape of the defect carries neither: `sub/.claude` is one
    // link that brings a whole rules directory with it, and the link's own path
    // stops at `.claude`. It read as "not a rules link" and said nothing, while
    // the adopter gate that found this class fails exactly this case.
    const issues = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('.claude'),
      symlinkCondition('packages/cli/.claude'),
    ]));

    expect(issues.map((issue) => issue.location))
      .toStrictEqual(['.claude', 'packages/cli/.claude']);
    expect(issues[0]?.message).toContain('every');
  });

  it('reports a NESTED rules directory link as well as a project-root one, each phrased for what it is', () => {
    const issues = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('packages/cli/.claude/rules/local.md'),
      symlinkCondition('packages/cli/.claude/rules/shared'),
    ]));

    expect(issues.map((issue) => issue.location))
      .toStrictEqual(['packages/cli/.claude/rules/local.md', 'packages/cli/.claude/rules/shared']);
    // 🪤 Asserting only the locations left the file/tree split unpinned: collapse
    // `rulesLinkKind` to `isTheDirectory ? 'tree' : 'file'` and both rows still
    // appear, under the wrong sentence — the `shared` row is neither markdown nor
    // the rules directory itself, so the mutant calls a whole linked directory
    // one file. That mutation survived; these two assertions kill it.
    expect(issues[0]?.message)
      .toContain("The rules file 'packages/cli/.claude/rules/local.md' is a symbolic link");
    expect(issues[1]?.message).toContain('at or under a directory Claude Code loads rules from');
    expect(issues[1]?.message).toContain('every rules file it reaches through the link');
  });

  it('reads the .md test case-insensitively, so a linked RULES.MD is still phrased as a file', () => {
    // 🪤 No fixture used an uppercase extension, so dropping the `.toLowerCase()`
    // before `.endsWith('.md')` stayed green. It is folded on purpose and only
    // here: the extension decides the WORDING, both arms are reported either way,
    // and on a case-insensitive host `LOCAL.MD` is exactly the file the harness
    // opens for `*.md` — so calling it a directory is the worse guess about a
    // link VAT never follows.
    const [issue] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules/LOCAL.MD')]),
    );

    expect(issue?.message).toContain("The rules file '.claude/rules/LOCAL.MD' is a symbolic link");
  });

  it('reports one finding per PATH, however many extents recorded the link', () => {
    // A link met by the filesystem walk and by git is two condition rows under
    // two extent ids, carrying one path. Two findings would double-count a
    // single file the way a join over realizations does.
    const issues = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('.claude/rules/linked.md'),
      symlinkCondition('.claude/rules/linked.md'),
    ]));

    expect(issues).toHaveLength(1);
  });

  it('⭐ reports BOTH declined-link codes — a filter on one drops the worse arm', () => {
    // 🪤 The consumers filtered on `EXTENT_SYMLINK_NOT_REALIZED` by string, so
    // introducing the second code would have made every out-of-root rules link
    // vanish from this check — the arm whose rule Claude Code does not load at
    // all — with typecheck unable to see it. `DECLINED_SYMLINK_CODES` is the one
    // contract; collapse `isDeclinedSymlinkCode` to either single code and one
    // of these two rows disappears.
    const issues = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('.claude/rules/inside.md'),
      symlinkCondition('.claude/rules/outside.md', EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT),
    ]));

    expect(issues.map((issue) => issue.location))
      .toStrictEqual(['.claude/rules/inside.md', '.claude/rules/outside.md']);
  });

  it('says NOTHING about a link outside a rules directory', () => {
    // The control. `CLAUDE.md -> AGENTS.md` is the commonest link in the corpus
    // and is no business of a rules check; a predicate that reported every
    // symlink would be the loudest possible way to be wrong.
    expect(CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('CLAUDE.md'),
      symlinkCondition('docs/shared'),
      symlinkCondition('.claude/agents/reviewer.md'),
    ]))).toStrictEqual([]);
  });

  it('says NOTHING about a case variant of a rules path, which is what the twin has to match', () => {
    // The segments are compared byte for byte, as `agentic-tags.ts` compares
    // them. These four are the rows the shipped SQL twin selected and this
    // predicate did not — written with LIKE, which SQLite makes
    // ASCII-case-insensitive — so they are pinned on BOTH sides: here, and in
    // `projection-sqlite`'s differential over the same list.
    expect(CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('.CLAUDE/rules/a.md'),
      symlinkCondition('.Claude/Rules/a.md'),
      symlinkCondition('.claude/RULES/a.md'),
      symlinkCondition('X/.CLAUDE'),
    ]))).toStrictEqual([]);
  });

  it('⭐ says the IN-ROOT rule is in force and unchecked, and how to make VAT see it', () => {
    // ⛔ The message said "The rule is in force and unchecked." full stop, and
    // for an out-of-root link that is false: Claude Code skips a rules file or
    // directory whose link target resolves outside the directory the session
    // started in (2.1.280; docs/external/claude-code-rules-paths-behaviour.md).
    // It then said NEITHER, hedging across both arms, because the verdict lived
    // only in the condition row's prose. It now dispatches on the row's CODE.
    const [issue] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules/linked.md')]),
    );

    expect(issue?.message).toContain('target is inside the project root');
    expect(issue?.message).toContain('it is in force and unchecked');
    expect(issue?.message).toContain('Replace the link with the file itself');
    // The hedge that survives, and only on this arm: the harness compares
    // against the session's own directory, VAT against the project root.
    expect(issue?.message).toContain('directory the session started in');
    // Where to look, since this finding never names the target.
    expect(issue?.message).toContain('EXTENT_SYMLINK_NOT_REALIZED');
    // ⛔ But never a promise the row keeps: a git link checked out as a plain
    // file (`core.symlinks=false`) draws this code and its row names no target.
    expect(issue?.message).not.toContain('names the target');
    // ⛔ And it does NOT hedge any more: the old sentence spanned both arms.
    expect(issue?.message).not.toContain('depends on where the link points');
  });

  it('⭐ says the OUT-OF-ROOT rule is in force NOWHERE, with the remedy that differs', () => {
    // The worse of the two defects, and the one the code exists to separate:
    // Claude Code skips the link, so the rule set the author believes governs
    // the session was never loaded. "Stop linking so VAT can check it" is the
    // wrong advice here — the rules have to come into the repository.
    const [issue, ...rest] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules/shared', EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT)]),
    );

    expect(rest).toStrictEqual([]);
    // One registry code and one severity across both arms: an adopter governs
    // the concern with one `resources.validation.severity` entry.
    expect(issue?.code).toBe('CLAUDE_RULE_LINK_UNCHECKED');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('target resolves outside the project root');
    expect(issue?.message).toContain('the rule set you meant to pull in is in force nowhere');
    expect(issue?.message).toContain('Copy or vendor those rules into the repository');
    expect(issue?.message).toContain(EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT);
    // ⛔ Never the in-root arm's remedy, which would tell the author to fix the
    // lesser problem and leave the rules unloaded.
    expect(issue?.message).not.toContain('it is in force and unchecked');
    expect(issue?.message).not.toContain('Replace the link with the file itself');
  });

  it('⭐ says a link that resolves NOWHERE loads nothing — never "in force"', () => {
    // A dangling rules link: Claude Code reads nothing through it, so telling
    // the author a rule is "in force and unchecked" describes a rule that does
    // not exist, and "outside the root" describes a target spelled inside it.
    const [issue, ...rest] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules/dangling.md', EXTENT_SYMLINK_TARGET_UNRESOLVED)]),
    );

    expect(rest).toStrictEqual([]);
    expect(issue?.code).toBe('CLAUDE_RULE_LINK_UNCHECKED');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('resolves to nothing on this host');
    expect(issue?.message).toContain('Claude Code loads nothing through it');
    expect(issue?.message).toContain(EXTENT_SYMLINK_TARGET_UNRESOLVED);
    expect(issue?.message).not.toContain('it is in force and unchecked');
    expect(issue?.message).not.toContain('outside the project root');
  });

  it('says NOTHING about a condition row carrying another code', () => {
    // Distinguishable at the seam: the same path under a different code.
    expect(CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([
      symlinkCondition('.claude/rules/linked.md', 'EXTENT_DIRECTORY_UNLISTABLE'),
    ]))).toStrictEqual([]);
    expect(CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('.claude/rules/linked.md')]),
    )).toHaveLength(1);
  });

  it('says nothing at all when no link was declined', () => {
    expect(CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(linkInput([]))).toStrictEqual([]);
  });

  it('declines a location the schema refuses rather than emitting one', () => {
    const [issue] = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run(
      linkInput([symlinkCondition('/etc/.claude/rules/x.md')]),
    );

    expect(issue?.location).toBeUndefined();
    expect(Object.hasOwn(issue ?? {}, 'location')).toBe(false);
  });
});

