/**
 * System tests for `vat claude context [path]`.
 *
 * ## Why these run against THIS repository rather than a temp fixture
 *
 * The claim under test is that the whole lane — enumerate, parse blobs, walk the
 * `@`-import closure, grade conditions, account for the cliff — produces a
 * non-empty answer on a real tree. `docs/CLAUDE.md` in this repository opens with
 * a literal `@README.md`, so a zero here is not a quiet fixture artefact: it means
 * the import lane stopped resolving. A fixture authored for this test would be a
 * fixture that cannot distinguish a working lane from a broken one, because the
 * same hand would have written both sides of the question.
 *
 * ⚠️ **Each populating invocation is a whole-project scan** (~7 s on this
 * monorepo), so the `--format json` answer is fetched ONCE in `beforeAll` and
 * shared. Three populations run in total: the JSON answer, the text rendering,
 * and the unknown-path query. The out-of-corpus test costs nothing — the path
 * check runs before the population does.
 *
 * ⚠️ The populating block is skipped on win32, matching
 * `packages/cli/vitest.system.config.ts`, which already excludes whole-project
 * scans there with the note *"10-20x slower"* — at that multiplier they do not
 * fit the 120 s per-test budget. The `--help` block runs everywhere.
 *
 * ⛔ Limit assertions search the output by CONTENT — never by index into
 * `CLAUDE_CONTEXT_LIMITS` and never by position in the printed section. The list
 * is grouped by `direction` rather than in any authored order, and it grows: an
 * index-based assertion would pass today and pin the wrong sentence tomorrow.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { createSuiteContext, executeCli, getMonorepoRoot } from './test-common.js';

const context = createSuiteContext('vat-claude-context-', import.meta.url);
const repoRoot = getMonorepoRoot(import.meta.url);

/** A row of the JSON document, narrowed to what these tests assert on. */
interface AnswerRow {
  path: string;
  admissions: Array<{ kind: string }>;
}

/** The JSON document, narrowed to what these tests assert on. */
interface ContextDocument {
  kind: string;
  input: string;
  reason?: string;
  totals?: { alwaysTokens: number; onDemandTokens: number };
  rows?: AnswerRow[];
  boundsStatement?: string;
  limits?: Array<{ id: string; direction: string; statement: string }>;
  modelledBehaviours?: Array<{ behaviour: string; introducedIn: string }>;
}

/**
 * Run `vat claude context …` from the repository root and parse its JSON.
 *
 * @param args - Arguments after `claude context`
 * @returns The exit status and the parsed document
 */
async function contextJson(
  args: readonly string[],
): Promise<{ status: number | null; document: ContextDocument }> {
  const result = await executeCli(
    context.binPath,
    ['claude', 'context', ...args, '--format', 'json'],
    { cwd: repoRoot },
  );
  return { status: result.status, document: JSON.parse(result.stdout) as ContextDocument };
}

describe('vat claude context --help', () => {
  beforeAll(context.setup);

  it('documents itself', async () => {
    const result = await executeCli(context.binPath, ['claude', 'context', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Description:');
    expect(result.stdout).toContain('--format');
    expect(result.stdout).toContain('Exit Codes:');
    expect(result.stdout).toContain('Example:');
  });

  it('promises no gate — every answer exits 0', async () => {
    const result = await executeCli(context.binPath, ['claude', 'context', '--help']);

    expect(result.stdout).toContain('there is no threshold and no gate');
  });

  it('is discoverable as an analysis verb from the claude group', async () => {
    const result = await executeCli(context.binPath, ['claude', '--help']);

    expect(result.status).toBe(0);
    // ⛔ The Commands-list ROW, not the group's prose. Both `context` and the
    // words "Context analysis" appear in the group's own `addHelpText`, which is
    // printed whether or not `createClaudeCommand` ever calls
    // `addCommand(createContextCommand())` — so searching for either passes on a
    // group that registers nothing. Only Commander's generated row proves the
    // subcommand is registered, and it fails the moment that call is removed.
    // The description is wrapped by Commander at 80 columns (stdout is a pipe
    // here, so there is no terminal width), hence matching only its first words;
    // the padding is ` +` rather than `\s+` because the term column's width is a
    // function of the longest sibling term, and because `\s` would match the
    // newline and make the pattern ambiguous.
    expect(result.stdout)
      .toMatch(/\n +context \[options\] \[path\] +Report what Claude Code loads/);
  });
});

describe.skipIf(process.platform === 'win32')('vat claude context', () => {
  let answer: ContextDocument;
  let answerStatus: number | null = null;

  beforeAll(async () => {
    context.setup();
    // ONE population for every assertion about the answer document — see header.
    const fetched = await contextJson(['docs']);
    answerStatus = fetched.status;
    answer = fetched.document;
  });

  it('answers for a real directory and exits 0 with no threshold', () => {
    expect(answerStatus).toBe(0);
    expect(answer.kind).toBe('answer');
    // This repo has a docs/CLAUDE.md importing docs/README.md, so the answer is
    // non-empty — a zero here means the import lane silently stopped resolving.
    expect(answer.totals?.alwaysTokens).toBeGreaterThan(0);
  });

  it('names the file that reached the answer only through an @-import', () => {
    const readme = answer.rows?.find((row) => row.path === 'docs/README.md');

    expect(readme, "docs/CLAUDE.md's @README.md should admit docs/README.md").toBeDefined();
    expect(readme?.admissions.map((admission) => admission.kind)).toContain('import');
  });

  // ⛔ "Never renders an unknown size as zero" is NOT asserted here, and that is
  // deliberate. Every file in this repository has a measured blob, so no row on
  // this tree has `tokens: null` — a loop pairing `row.tokens === null` with
  // `row.charge === 'unknown-size'` compares `false === false` on every row and
  // passes vacuously, and it would keep passing if the renderer were changed to
  // `${row.tokens ?? 0} tokens`. It also asserts a property of `account()`
  // rather than of the CLI, and `account()` pins it directly. The renderer's
  // rule is pinned where it can actually fail — over `chargeText` with the null
  // this tree never supplies — in
  // `packages/cli/test/commands/claude/context-charge-text.test.ts`.

  it('carries its limits in the machine-readable document too', () => {
    expect(answer.boundsStatement).toContain('neither a floor nor a ceiling');
    // Looked up by id, never by position: the list is grouped by direction, so
    // every entry added to a group shifts the ones after it.
    const cliff = answer.limits?.find((limit) => limit.id === 'cliff-scope');
    expect(cliff?.direction).toBe('scope');
    expect(answer.modelledBehaviours?.length).toBeGreaterThan(0);
  });

  it("states its limits in the default text format, because they are the answer's shape", async () => {
    const result = await executeCli(context.binPath, ['claude', 'context', 'docs'], {
      cwd: repoRoot,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('neither a floor nor a ceiling');
    expect(result.stdout).toContain('What this answer does not settle');
    // Found by searching the rendering, not by taking the Nth printed limit.
    expect(result.stdout).toContain('claude-md-excludes');
    // ⛔ None of the words that would read as a settled figure.
    expect(result.stdout).not.toMatch(/total cost|all context|complete context/i);
  });

  it('answers unknown — not zero — for a path that is not in the tree', async () => {
    const { status, document } = await contextJson(['no/such/path']);

    expect(status).toBe(0);
    expect(document).toMatchObject({ kind: 'unknown', reason: 'path-not-realized' });
    // Structurally a non-answer: nothing a consumer could read as a measurement.
    expect(document.totals).toBeUndefined();
    expect(document.rows).toBeUndefined();
  });

  it('refuses a path outside the corpus root rather than answering unknown for it', async () => {
    const result = await executeCli(
      context.binPath,
      ['claude', 'context', '../..', '--format', 'json'],
      { cwd: repoRoot },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('outside the corpus root');
  });
});
