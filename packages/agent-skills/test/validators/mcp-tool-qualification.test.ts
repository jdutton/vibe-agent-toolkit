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

/** Median wall-clock ms of a few runs, to blunt scheduler noise. */
function medianMs(work: () => void, runs = 5): number {
  const samples: number[] = [];
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  // Spread-then-sort rather than `toSorted`: the tsconfig `lib` predates ES2023.
  return [...samples].sort((a, b) => a - b)[Math.floor(runs / 2)] ?? 0;
}

describe('qualifiedMcpToolNames — the detector’s premise', () => {
  it('takes the tool from the LAST __ so a multi-segment server name is not split early', () => {
    // `mcp__plugin_github_github__get_me` must yield `get_me`, never
    // `github__get_me` — the server half itself contains underscores.
    expect([...qualifiedMcpToolNames('`mcp__plugin_github_github__get_me`')]).toEqual(['get_me']);
  });

  it('reads the API spelling when the server half carries an uppercase letter', () => {
    const vocabulary = qualifiedMcpToolNames('Call `GitHub:create_issue` and `BigQuery:bigquery_schema`.');
    expect([...vocabulary].sort((a, b) => a.localeCompare(b))).toEqual(['bigquery_schema', 'create_issue']);
  });

  // Both of these were MEASURED false-vocabulary sources: the first on VAT's own
  // packages/utils/README.md, the second in a partner-built plugin in the install
  // corpus. Neither is visible on a corpus of ordinary skills, which is exactly
  // why docs/validation-rule-design.md requires the authoring-project check.
  it.each([
    ['a node builtin specifier', 'Import from `node:child_process` for spawning.'],
    ['an OAuth scope string', 'Requires the `whiteboard:read:list_whiteboards` scope.'],
    ['a lowercase URI scheme', 'See `https://example.com/get_thing_x` for details.'],
  ])('does not build vocabulary from %s', (_label, body) => {
    expect(qualifiedMcpToolNames(body).size).toBe(0);
  });
});

// The vocabulary patterns were restructured to satisfy sonarjs/super-linear-regex.
// A linter passing is not evidence that the runtime got better — a regex can be
// rewritten into a shape the checker likes while staying quadratic. So measure the
// growth instead of trusting either the rule or the comment explaining it.
describe('qualifiedMcpToolNames — cost grows with input, not with input squared', () => {
  // A long token carrying no colon is the shape that made the natural spelling
  // quadratic: every character is a candidate start, and each start scans to the
  // end of the token before failing.
  it.each([
    ['one colonless token', (n: number) => 'a'.repeat(n)],
    ['a hyphenated run', (n: number) => 'a-'.repeat(n / 2)],
    ['tokens ending in a colon that never completes', (n: number) => 'ab:'.repeat(n / 3)],
  ])('stays roughly linear on %s', (_label, build) => {
    const small = build(20_000);
    const large = build(80_000); // 4x the input

    const smallMs = Math.max(medianMs(() => qualifiedMcpToolNames(small)), 0.05);
    const largeMs = medianMs(() => qualifiedMcpToolNames(large));

    // Linear predicts ~4x; quadratic predicts ~16x. The 10x gate sits between
    // them with room for a loaded machine, so this fails on a real regression
    // without flaking on a busy CI box.
    expect(largeMs / smallMs).toBeLessThan(10);
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

  it('stays silent when the document never spells any tool fully-qualified', () => {
    // The whole reservation the checklist held this rule back on: a bare
    // snake_case identifier is not evidence that a skill drives MCP.
    expect(issuesFor('Set `page_size` and pass `next_page_token` to continue.')).toEqual([]);
  });

  it('does not report the qualified line itself', () => {
    // The line carrying `mcp__…` is the definition the vocabulary was built
    // from. Reporting it would flag the very spelling the code asks authors for.
    expect(issuesFor('Use `mcp__zoom__recordings_list` to list recordings.')).toEqual([]);
  });

  it('ignores a bare tool name outside a code span', () => {
    // An agent copies what is inside backticks; the same word in running prose
    // is discussion, and admitting it was measured to add only noise.
    expect(issuesFor('Use `mcp__gh__get_me` first.\nThe get_me call is cheap.\n')).toEqual([]);
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
