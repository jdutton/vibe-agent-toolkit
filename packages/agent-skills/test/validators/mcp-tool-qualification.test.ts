import { applyAllowFilter, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import {
  collectUnqualifiedMcpToolIssues,
  qualifiedMcpToolNames,
} from '../../src/validators/mcp-tool-qualification.js';

const LOCATION = 'SKILL.md';

function issuesFor(body: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  collectUnqualifiedMcpToolIssues(body, LOCATION, issues);
  return issues;
}

const links = (issues: readonly ValidationIssue[]) => issues.map(issue => issue.link);

const sorted = (vocabulary: Iterable<string>) => [...vocabulary].sort((a, b) => a.localeCompare(b));

/**
 * Fastest wall-clock ms of a few runs. The FASTEST run, not the median: the
 * question this asks is "can this input ever be processed quickly", and a
 * scheduler steal only ever makes a sample slower, never faster. Taking the
 * minimum is the statistic least contaminated by an unrelated busy core.
 */
function fastestMs(work: () => void, runs = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('qualifiedMcpToolNames — the detector’s premise', () => {
  // The docstring used to claim the non-greedy server segment made the LAST
  // `__` the separator. It does not — non-greedy stops at the FIRST one, and
  // FIRST is also what Claude Code's own naming wants: it joins the server
  // segments with single underscores (`plugin_<plugin>_<server>`), so the first
  // `__` after `mcp__` always closes the server half.
  it.each([
    // Single-underscore server half: first and last `__` coincide, so this
    // fixture cannot tell the two readings apart on its own — it is here for
    // the shape it documents, not as the discriminator.
    ['a multi-segment server name', 'mcp__plugin_github_github__get_me', 'get_me'],
    // THE discriminator: two `__` after the server. First-`__` yields
    // `gmail__send_email`; last-`__` would yield `send_email`.
    ['a tool half that itself contains __', 'mcp__zapier__gmail__send_email', 'gmail__send_email'],
  ])('splits %s at the FIRST __ after the server', (_label, qualified, tool) => {
    expect([...qualifiedMcpToolNames(`\`${qualified}\``)]).toEqual([tool]);
  });

  // Claude Code mounts plugin servers as `plugin_<plugin>_<server>`, and
  // hyphenated plugin names are the norm. `\w` excludes `-`, so these matched
  // NOTHING: a document driving MCP solely through such a server had an empty
  // vocabulary and could not produce a finding — including a true one.
  it.each([
    ['a hyphenated server name', 'mcp__claude-in-chrome__browser_batch', 'browser_batch'],
    [
      'a hyphenated plugin AND server segment',
      'mcp__plugin_microsoft-docs_microsoft-learn__microsoft_docs_search',
      'microsoft_docs_search',
    ],
  ])('reads %s', (_label, qualified, tool) => {
    expect([...qualifiedMcpToolNames(`\`${qualified}\``)]).toEqual([tool]);
  });

  // Hyphenated TOOL names are just as common (context7 ships both of these).
  // A tool capture that stopped at the hyphen put the bare English words
  // `resolve` and `query` into the vocabulary, and every later code span
  // spelling either of them became a finding.
  it('captures a hyphenated tool name whole, not up to the first hyphen', () => {
    const vocabulary = qualifiedMcpToolNames(
      'Look it up with `mcp__plugin_context7_context7__resolve-library-id`,\n' +
      'then `mcp__plugin_context7_context7__query-docs`.\n',
    );
    expect(sorted(vocabulary)).toEqual(['query-docs', 'resolve-library-id']);
  });

  it('reads the API spelling when the server half carries an uppercase letter', () => {
    const vocabulary = qualifiedMcpToolNames('Call `GitHub:create_issue` and `BigQuery:bigquery_schema`.');
    expect(sorted(vocabulary)).toEqual(['bigquery_schema', 'create_issue']);
  });

  /**
   * 🚨 camelCase tool names were INVISIBLE, on BOTH lanes — not truncated, gone.
   *
   * Both captures used to end on `\b`. When the character after the captured run
   * is an UPPERCASE letter, both sides of that position are word characters, so
   * `\b` fails; the engine then gives the lowercase class back one character at a
   * time and every interior position is word|word too, so the WHOLE match is
   * abandoned. `mcp__linear__createIssue` produced `[]` — not `['create']`.
   *
   * The consequence is the detector's own defect: a document that spells a
   * camelCase tool qualified once and bare afterwards had an EMPTY vocabulary and
   * reported nothing. camelCase is the ordinary spelling for TypeScript-authored
   * MCP servers, so this was the common case, not a corner.
   *
   * The hyphen family survived only because `-` is a NON-word character — which
   * is exactly why `foo-Bar` had a fixture and `fooBar` had none. An assertion
   * that a name is captured WHOLE cannot see this class; only one that asserts
   * the name is captured AT ALL can.
   */
  it.each([
    ['a camelCase tool in the mcp__ spelling', 'mcp__linear__createIssue', 'createIssue'],
    ['snake_case with a camelCase tail', 'mcp__x__get_userInfo', 'get_userInfo'],
    ['a camelCase tool on a hyphenated server', 'mcp__claude-in-chrome__uploadImage', 'uploadImage'],
  ])('reads %s', (_label, qualified, tool) => {
    expect([...qualifiedMcpToolNames(`\`${qualified}\``)]).toEqual([tool]);
  });

  it('reads a camelCase tool in the API spelling', () => {
    expect(sorted(qualifiedMcpToolNames('Call `GitHub:createIssue` then `GitHub:listIssues`.')))
      .toEqual(['createIssue', 'listIssues']);
  });

  /**
   * The camelCase HUMP is what admits these names, and without it the regex fix
   * above buys nothing: `createIssue` carries neither `_` nor `-`, so the
   * multi-segment gate — written as "contains a separator" — would refuse every
   * one of them and leave the vocabulary empty exactly as `\b` did. A hump
   * answers the gate's real question ("name, or ordinary English word?") as well
   * as a separator does.
   */
  it('still refuses a ONE-WORD camelCase-free name from the same server', () => {
    const vocabulary = qualifiedMcpToolNames(
      'Use `mcp__claude-in-chrome__find` and `mcp__claude-in-chrome__uploadImage`.',
    );
    expect(sorted(vocabulary)).toEqual(['uploadImage']);
  });

  // Both of these were MEASURED false-vocabulary sources: the first on VAT's own
  // packages/utils/README.md, the second in a partner-built plugin in the install
  // corpus. Neither is visible on a corpus of ordinary skills, which is exactly
  // why docs/validation-rule-design.md requires the authoring-project check.
  it.each([
    ['a node builtin specifier', 'Import from `node:child_process` for spawning.'],
    ['an OAuth scope string', 'Requires the `whiteboard:read:list_whiteboards` scope.'],
    ['a lowercase URI scheme', 'See `https://example.com/get_thing_x` for details.'],
    // The server half must be spelled the way Anthropic's examples spell one:
    // uppercase FIRST, and no underscore. Measured cost-free — over 884 documents
    // (206 authoring-project `.md` + 678 installed `SKILL.md`) the looser
    // "uppercase anywhere" rule accepted exactly three distinct server halves,
    // `GitHub`, `BigQuery` and the guidance template's own `ServerName`, and the
    // strict rule accepts all three.
    ['a server half whose uppercase is not first', 'Set `xGitHub:create_issue` in the map.'],
    ['a server half carrying an underscore', 'Set `My_Server:create_issue` in the map.'],
  ])('does not build vocabulary from %s', (_label, body) => {
    expect(qualifiedMcpToolNames(body).size).toBe(0);
  });

  // The invariant the packaging validator's SKILL.md lane has always asserted —
  // "an `allowed-tools:` list of `mcp__…` names does not by itself supply the
  // vocabulary" — enforced HERE, so it holds for every caller. It used to hold
  // only because that one lane happened to pass a frontmatter-stripped slice,
  // while the bundled-`.md` lane passed whole files.
  it('does not build vocabulary from YAML frontmatter', () => {
    const vocabulary = qualifiedMcpToolNames(
      '---\nname: demo\nallowed-tools:\n  - mcp__x__do_thing\n---\n\nRun the thing.\n',
    );
    expect(vocabulary.size).toBe(0);
  });

  /**
   * 🚨 The one-word hole the hyphen fix did NOT close.
   *
   * `API_QUALIFIED` demanded an underscore in the tool half; `mcp__…` demanded
   * nothing. So `mcp__claude-in-chrome__find` seeded the vocabulary with `find`,
   * and every later code span spelling that ordinary English word became a
   * finding. Same family as `resolve-library-id` → `resolve`, but the opposite
   * mechanism: that one truncated a name, this one admits a name that is one
   * word to begin with. Zero occurrences over 291 repo docs (the whole tree's
   * `.md`, `dist`/`node_modules`/`.claude/worktrees` excluded), re-measured after
   * the camelCase fix — so it is structural rather than observed.
   */
  it('does not build vocabulary from a ONE-WORD tool name in the mcp__ spelling', () => {
    const vocabulary = qualifiedMcpToolNames(
      'Locate it with `mcp__claude-in-chrome__find`, then use `find` again later.',
    );

    expect(vocabulary.size).toBe(0);
  });

  it('still admits a multi-word tool name spelled with hyphens, not just underscores', () => {
    // The gate is "multi-segment", not "contains an underscore". Requiring `_`
    // would drop the real kebab-cased tools the hyphen fix exists to preserve.
    expect(sorted(qualifiedMcpToolNames('`mcp__plugin_context7_context7__query-docs`')))
      .toEqual(['query-docs']);
  });

  /**
   * `withoutTrailingSeparators` had no test of its own, and `return tool;`
   * survived.
   *
   * ⚠️ This case used to be `mcp__x__browser_click-Beta` → `browser_click`, and
   * that expectation was a symptom of the `\b` defect rather than a requirement:
   * the capture stopped at the hyphen only because uppercase was excluded from
   * the class. A tool actually spelled `browser_click-Beta` IS named
   * `browser_click-Beta`, and it is now read whole — see the camelCase cases
   * above. The reachable trailing-separator shape is a separator followed by a
   * NON-name character, which the closing backtick supplies here.
   */
  it('strips a trailing separator the greedy capture leaves behind', () => {
    expect(sorted(qualifiedMcpToolNames('Call `mcp__x__browser_click_` on the beta server.')))
      .toEqual(['browser_click']);
  });

  it('captures a hyphen-then-uppercase tool name whole', () => {
    expect(sorted(qualifiedMcpToolNames('`mcp__x__browser_click-Beta` in the beta server')))
      .toEqual(['browser_click-Beta']);
  });
});

// A regex can be rewritten into a shape a checker likes while staying
// quadratic, so the linter's verdict is not evidence about runtime. This
// measures instead — but as an ABSOLUTE budget, not a ratio.
//
// What it proves: the catastrophic case is gone. Removing the `(?<![\w-])`
// lookbehind from `API_QUALIFIED` was measured at 2595 ms on 80 KB of a
// colonless token; keeping it costs 0.22 ms. Four orders of magnitude separate
// the two, so a fixed budget anywhere between them is a real gate.
//
// What it does NOT prove: linearity. It is a single input size, and it says
// nothing about the growth curve below the budget. The previous shape — a
// ratio against a `Math.max(…, 0.05)` floor — looked stronger and was weaker:
// on a fast machine the floor is fabricated rather than measured, which
// silently converts the ratio into an absolute of the test author's choosing,
// and this file is coverage-instrumented on `test:coverage`, where the v8
// overhead is not uniform across input sizes.
describe('qualifiedMcpToolNames — no catastrophic backtracking', () => {
  // A long token carrying no colon is the shape that goes quadratic without the
  // lookbehind: every character is a candidate start, and each start scans to
  // the end of the token before failing.
  it.each([
    ['one colonless token', (n: number) => 'a'.repeat(n)],
    ['a hyphenated run', (n: number) => 'a-'.repeat(n / 2)],
    ['tokens ending in a colon that never completes', (n: number) => 'ab:'.repeat(n / 3)],
    ['an mcp__ prefix that never completes', (n: number) => 'mcp__a'.repeat(n / 6)],
  ])('processes 80 KB of %s well inside a fixed budget', (_label, build) => {
    const large = build(80_000);
    expect(fastestMs(() => qualifiedMcpToolNames(large))).toBeLessThan(250);
  });
});

describe('collectUnqualifiedMcpToolIssues', () => {
  it('reports a bare tool name the same document spells fully-qualified', () => {
    // The measured live instance, reduced: the frontmatter-style qualified name
    // appears in the body, and the step below names the tool bare.
    const issues = issuesFor(
      'Resolve the user via `mcp__plugin_github_github__get_me`.\n' +
      'Availability probe — run `get_me` once; on failure, scaffold locally.\n',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('MCP_TOOL_NAME_UNQUALIFIED');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.link).toBe('get_me');
    expect(issues[0]?.line).toBe(2);
  });

  /**
   * The end-to-end consequence of the `\b` defect, on both lanes: these two
   * documents are the exact shape the rule exists to report, and the shipped
   * detector said nothing about either — the vocabulary was empty, so the loop
   * that reports bare names never ran.
   */
  it.each([
    [
      'the mcp__ spelling',
      'Link the records with `mcp__tracker__addCaseLinks`.\n' +
      'Then call `addCaseLinks` for every sibling id.\n',
      'addCaseLinks',
    ],
    [
      'the API spelling',
      'Open one with `GitHub:createIssue`.\n' +
      'Then call `createIssue` once per finding.\n',
      'createIssue',
    ],
    [
      'a mixed snake_case + camelCase name',
      'Fetch it via `mcp__x__get_userInfo`.\n' +
      'Cache the `get_userInfo` result for the session.\n',
      'get_userInfo',
    ],
  ])('reports a bare camelCase tool name qualified elsewhere in %s', (_label, body, tool) => {
    const issues = issuesFor(body);
    expect(links(issues)).toEqual([tool]);
    expect(issues[0]?.line).toBe(2);
  });

  it('stays silent when the document never spells any tool fully-qualified', () => {
    // The whole reservation the checklist held this rule back on: a bare
    // snake_case identifier is not evidence that a skill drives MCP.
    expect(issuesFor('Set `page_size` and pass `next_page_token` to continue.')).toEqual([]);
  });

  // The end-to-end consequence of the hyphen fix: a document that drives two
  // real hyphenated tools, and separately discusses an ordinary `query` field
  // and a `resolve` hook, must say nothing about either English word.
  it('does not report English words that merely prefix a hyphenated tool name', () => {
    expect(issuesFor(
      'Look it up with `mcp__plugin_context7_context7__resolve-library-id`,\n' +
      'then `mcp__plugin_context7_context7__query-docs`.\n' +
      '\n' +
      'The store exposes a `query` field and a `resolve` hook you can override.\n',
    )).toEqual([]);
  });

  it('does not report a tool the same line spells fully-qualified', () => {
    // Both spellings, and both must be exempt — the API form is the one this
    // module's docstring leads with, and it had no exemption at all.
    expect(issuesFor('Use `recordings_list` — that is `mcp__zoom__recordings_list`.')).toEqual([]);
    expect(issuesFor('Issue tools: `create_issue` — fully qualified, `GitHub:create_issue`.')).toEqual([]);
  });

  it('does not report the rows of a bare-name → qualified-name mapping table', () => {
    expect(issuesFor(
      '| Bare | Qualified |\n' +
      '|---|---|\n' +
      '| `get_me` | `GitHub:get_me` |\n' +
      '| `create_issue` | `GitHub:create_issue` |\n',
    )).toEqual([]);
  });

  // The exemption is per-MATCH, not per-line. A line that qualifies tool A and
  // names tool B bare is exactly the defect this check exists to report, and a
  // per-line skip dropped it silently.
  it('reports a bare tool on a line that qualifies a DIFFERENT tool', () => {
    const issues = issuesFor('1. Call `mcp__github__list_issues`, then `get_issue` for each id.\n' +
      'Qualified elsewhere: `mcp__github__get_issue`.\n');
    expect(links(issues)).toEqual(['get_issue']);
    expect(issues[0]?.line).toBe(1);
  });

  it('ignores a bare tool name outside a code span', () => {
    // An agent copies what is inside backticks; the same word in running prose
    // is discussion, and admitting it was measured to add only noise.
    expect(issuesFor('Use `mcp__gh__get_me` first.\nThe get_me call is cheap.\n')).toEqual([]);
  });

  // The frontmatter invariant, seen through the emitter rather than the
  // vocabulary: this is the exact shape of the bundled-`.md` false positive.
  it('does not fire on a body whose only qualified spelling is in frontmatter', () => {
    expect(issuesFor(
      '---\nallowed-tools:\n  - mcp__x__do_thing\n---\n\nCall `do_thing` when the user asks.\n',
    )).toEqual([]);
  });

  /**
   * Frontmatter is BLANKED, not removed, and the reported `line` is what says so.
   *
   * `scannableLines` overwrites the frontmatter lines with `''` so every later
   * line keeps its number. `lines.slice(end)` would strip the same content and
   * shift every finding upward — and it survived the whole suite, because no case
   * asserted a `line` on a document that HAS frontmatter. That is the shipped
   * SKILL.md lane: every skill file starts with frontmatter.
   */
  it('keeps line numbers true on a document that HAS frontmatter', () => {
    const issues = issuesFor(
      '---\n' +               // 1
      'name: demo\n' +        // 2
      'description: x\n' +    // 3
      '---\n' +               // 4
      '\n' +                  // 5
      'Qualified: `mcp__gh__get_me`.\n' + // 6
      'Now run `get_me`.\n',              // 7
    );

    expect(links(issues)).toEqual(['get_me']);
    expect(issues[0]?.line).toBe(7);
  });

  it('emits one issue per distinct tool per line, not one per document', () => {
    const issues = issuesFor(
      'Tools: `mcp__gh__create_repository`, `mcp__gh__create_branch`.\n' +
      'Then call `create_repository`, `create_branch` (main).\n',
    );
    expect(links(issues)).toEqual(['create_repository', 'create_branch']);
    expect(issues.every(issue => issue.line === 2)).toBe(true);
  });

  it('does not repeat a tool named twice on the same line', () => {
    const issues = issuesFor('Qualified: `mcp__gh__get_me`.\nRun `get_me`, then `get_me` again.\n');
    expect(issues).toHaveLength(1);
  });

  // The design rule for every new check: anchor on the offending thing so a
  // single misfire is waivable without silencing the document. `applyAllowFilter`
  // matches an allow glob against `location` OR `link`.
  it('lets an allow entry waive one tool while a sibling in the same file still fires', () => {
    const issues = issuesFor(
      'Tools: `mcp__gh__get_me`, `mcp__gh__create_branch`.\n' +
      'Run `get_me`, then `create_branch`.\n',
    );
    expect(links(issues)).toEqual(['get_me', 'create_branch']);

    const { emitted, allowed } = applyAllowFilter(issues, {
      allow: {
        MCP_TOOL_NAME_UNQUALIFIED: [
          { paths: ['get_me'], reason: 'Named bare in the availability probe on purpose.' },
        ],
      },
    });
    // The glob names a TOOL, and both issues share one `location` — so a match
    // here is only possible via the `link` anchor. That is the whole point.
    expect(allowed).toHaveLength(1);
    expect(links(emitted)).toEqual(['create_branch']);
  });
});
