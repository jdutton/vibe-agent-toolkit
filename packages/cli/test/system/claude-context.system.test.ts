/**
 * System tests for `vat claude context [paths...]`.
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

/** A file inside the corpus — the EXACT query case. */
const A_FILE = 'packages/cli/src/index.ts';
/** A directory inside the corpus — the "may fire here" query case. */
const A_DIRECTORY = 'docs';
/** A path the projection never realizes — the `kind: unknown` case. */
const AN_UNREALIZED_PATH = 'no/such/path';

/**
 * The per-answer heading `--all` must NEVER emit any more.
 *
 * ⛔ Searched for as the literal heading rather than as a path, because a path
 * appears in the cost map legitimately — the whole point of the map is naming
 * directories. Only this heading proves a per-path ANSWER block was rendered.
 */
const PER_PATH_HEADING = 'Claude Code context at ';

/** The limits section's heading — counted, never merely looked for. */
const LIMITS_HEADING = 'What this answer does not settle';

/** The bounds statement's distinguishing phrase, searched by CONTENT. */
const BOUNDS_PHRASE = 'neither a floor nor a ceiling';

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
  /**
   * ⛔ Declared only so the "no answer carries them" assertion can be WRITTEN.
   * The shipped `ContextAnswerDocument` has no such fields — they are the
   * envelope's — and a narrowing interface that simply omitted them would make
   * the absence unassertable rather than asserted.
   */
  boundsStatement?: string;
  limits?: unknown;
  modelledBehaviours?: unknown;
}

/** The envelope every run emits, however many paths were asked about. */
interface ContextEnvelope {
  kind?: string;
  root: string;
  answers: ContextDocument[];
  boundsStatement?: string;
  limits?: Array<{ id: string; direction: string; statement: string }>;
  modelledBehaviours?: Array<{ behaviour: string; introducedIn: string }>;
}

/**
 * The `--all` envelope, narrowed to what these tests assert on.
 *
 * ⛔ `answers` is declared here even though the shipped shape has no such field,
 * for the same reason `ContextDocument` declares `limits`: the assertion is an
 * ABSENCE, and a narrowing interface that simply omitted the field would make it
 * unwritable rather than proven.
 */
interface CostMapEnvelope {
  kind?: string;
  root: string;
  answers?: unknown;
  costMap?: {
    regions?: Array<{ representative: string; alwaysTokens: number; locationCount: number }>;
    directories?: Array<{ directory: string; onDemandTokens: number }>;
    queriedDirectories?: number;
    evaluatedDirectories?: number;
    skippedUnknownLocations?: number;
  };
  boundsStatement?: string;
  limits?: Array<{ id: string; direction: string; statement: string }>;
  modelledBehaviours?: Array<{ behaviour: string; introducedIn: string }>;
}

/**
 * Run `vat claude context …` from the repository root and parse its JSON.
 *
 * Returns the envelope AND its first answer. Most assertions here are about one
 * path's answer, so unwrapping keeps them readable; `envelope` is there for the
 * ones that are about the envelope itself, which is the only place the array
 * shape can be pinned.
 *
 * @param args - Arguments after `claude context`
 * @returns The exit status, the envelope, and its first answer
 */
async function contextJson(
  args: readonly string[],
): Promise<{ status: number | null; document: ContextDocument; envelope: ContextEnvelope }> {
  const result = await executeCli(
    context.binPath,
    ['claude', 'context', ...args, '--format', 'json'],
    { cwd: repoRoot },
  );
  const envelope = JSON.parse(result.stdout) as ContextEnvelope;
  const first = envelope.answers[0];
  // Loud rather than `!`: an envelope with no answers means the command stopped
  // producing them, and every assertion downstream would then fail on `undefined`
  // with a message that names the field instead of the cause.
  if (first === undefined) throw new Error(`no answers in envelope for: ${args.join(' ')}`);
  return { status: result.status, envelope, document: first };
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
      .toMatch(/\n +context \[options\] \[paths\.\.\.\] +Report what Claude Code loads/);
  });
});

describe.skipIf(process.platform === 'win32')('vat claude context', () => {
  let answer: ContextDocument;
  let envelope: ContextEnvelope;
  let answerStatus: number | null = null;

  beforeAll(async () => {
    context.setup();
    // ONE population for every assertion about the answer document — see header.
    const fetched = await contextJson([A_DIRECTORY]);
    answerStatus = fetched.status;
    answer = fetched.document;
    envelope = fetched.envelope;
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

  it('carries its limits in the machine-readable output too — on the ENVELOPE', () => {
    expect(envelope.boundsStatement).toContain(BOUNDS_PHRASE);
    // Looked up by id, never by position: the list is grouped by direction, so
    // every entry added to a group shifts the ones after it.
    const cliff = envelope.limits?.find((limit) => limit.id === 'cliff-scope');
    expect(cliff?.direction).toBe('scope');
    expect(envelope.modelledBehaviours?.length).toBeGreaterThan(0);
    // ⛔ And NOT on the answer. The limits bound the method, so a per-answer copy
    // is both a lie about scope and, on a sweep, tens of megabytes of one
    // repeated paragraph. The count is pinned over a many-answer envelope in
    // `test/commands/claude/context-envelope-limits.test.ts`; this end of it is
    // what proves the shipped binary agrees.
    expect('limits' in answer).toBe(false);
    expect('boundsStatement' in answer).toBe(false);
    expect('modelledBehaviours' in answer).toBe(false);
  });

  it("states its limits in the default text format, because they are the answer's shape", async () => {
    const result = await executeCli(context.binPath, ['claude', 'context', A_DIRECTORY], {
      cwd: repoRoot,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(BOUNDS_PHRASE);
    expect(result.stdout).toContain(LIMITS_HEADING);
    // Found by searching the rendering, not by taking the Nth printed limit.
    expect(result.stdout).toContain('claude-md-excludes');
    // ⛔ None of the words that would read as a settled figure.
    expect(result.stdout).not.toMatch(/total cost|all context|complete context/i);
  });

  it('answers unknown — not zero — for a path that is not in the tree', async () => {
    const { status, document } = await contextJson([AN_UNREALIZED_PATH]);

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

describe('vat claude context with several paths', () => {
  beforeAll(context.setup);

  it('answers every path, in the order asked, from one enumeration', async () => {
    const { status, envelope } = await contextJson([
      A_FILE,
      A_DIRECTORY,
      AN_UNREALIZED_PATH,
    ]);

    expect(status).toBe(0);
    // Order is the ARGUMENT order, not the projection's. A caller zipping its
    // own list against `answers` is the obvious use, and sorting here would
    // silently misalign it.
    expect(envelope.answers.map((answer) => answer.input)).toEqual([
      A_FILE,
      A_DIRECTORY,
      AN_UNREALIZED_PATH,
    ]);
    // A miss among hits stays a miss — one unresolvable path must not degrade
    // the answers around it, nor be quietly dropped from the list.
    expect(envelope.answers.map((answer) => answer.kind)).toEqual([
      'answer',
      'answer',
      'unknown',
    ]);
    expect(envelope.root).toContain('vibe-agent-toolkit');
  });

  it('emits a LIST for a single path, so a consumer never branches on count', async () => {
    const { envelope } = await contextJson([A_DIRECTORY]);

    expect(Array.isArray(envelope.answers)).toBe(true);
    expect(envelope.answers).toHaveLength(1);
  });

  it('defaults to the current directory, NOT the whole corpus, when given no path', async () => {
    const { status, envelope } = await contextJson([]);

    expect(status).toBe(0);
    // The guard on the friendliest invocation: a bare run must stay a
    // one-answer question. `--all` is the sweep, and it is spelled out.
    expect(envelope.answers).toHaveLength(1);
  });

  it('states the limits once for many paths, not once per path', async () => {
    const result = await executeCli(
      context.binPath,
      ['claude', 'context', A_FILE, A_DIRECTORY, 'README.md'],
      { cwd: repoRoot },
    );

    expect(result.status).toBe(0);
    // Three answers, one limits section. The limits bound the METHOD, so
    // repeating them per path would read as three independent sets of caveats.
    const occurrences = result.stdout.split(LIMITS_HEADING).length - 1;
    expect(occurrences).toBe(1);
    expect(result.stdout).toContain(A_FILE);
    expect(result.stdout).toContain('README.md');
  });

  it('answers only for named paths — never the whole tree — without --all', async () => {
    const { envelope } = await contextJson([A_DIRECTORY]);

    // The discriminator exists so a consumer never has to guess which of the two
    // documents it holds. Reading `answers` off a cost map would be silent.
    expect(envelope.kind).toBe('context-answers');
  });

  it('rejects an out-of-corpus path BEFORE enumerating, even among valid ones', async () => {
    const result = await executeCli(
      context.binPath,
      ['claude', 'context', A_DIRECTORY, '../..', '--format', 'json'],
      { cwd: repoRoot },
    );

    // The refusal must survive being in position two. Resolving arguments after
    // the population would charge a caller a full enumeration — minutes on a
    // cold cache — only to then reject what they typed.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('outside the corpus root');
    // ⛔ NOT `toBe('')`. `handleCommandError` writes its `status: error` block to
    // stdout even under `--format json` — a real defect, tracked separately, and
    // asserting an empty stdout here would pin a fix this change does not make.
    // What must hold is that a refused run publishes no MEASUREMENT: no
    // envelope, no answers, nothing a consumer could read as context that loads.
    //
    // 🪤 Matched on FIELD names, never the word "answers" — the refusal's own
    // prose says "vat claude context answers only for paths inside the root",
    // so a bare-word check fails on the very message it is meant to allow.
    expect(result.stdout).not.toContain('alwaysTokens');
    expect(result.stdout).not.toContain('boundsStatement');
  });
});

/**
 * `--all` — the whole-tree COST MAP, and no longer a per-path sweep.
 *
 * ⚠️ Two populating runs, fetched once each in `beforeAll` and shared: the text
 * rendering and the json envelope. The previous shape of this flag emitted one
 * document per realized path — 10,438 of them on a large adopter monorepo — and
 * had NO test anywhere that ran it, which is how that shipped.
 *
 * ⛔ The limits assertion is a COUNT, not a presence check. Presence passes when
 * the block is repeated once per region, which is precisely the burial this
 * command already shipped once in json.
 */
describe.skipIf(process.platform === 'win32')('vat claude context --all', () => {
  let text = '';
  let textStatus: number | null = null;
  let envelope: CostMapEnvelope;
  let jsonStatus: number | null = null;

  beforeAll(async () => {
    context.setup();
    const rendered = await executeCli(context.binPath, ['claude', 'context', '--all'], {
      cwd: repoRoot,
    });
    text = rendered.stdout;
    textStatus = rendered.status;

    const serialized = await executeCli(
      context.binPath,
      ['claude', 'context', '--all', '--format', 'json'],
      { cwd: repoRoot },
    );
    jsonStatus = serialized.status;
    envelope = JSON.parse(serialized.stdout) as CostMapEnvelope;
  });

  it('reports where the cost IS, region by region, and exits 0', () => {
    expect(textStatus).toBe(0);
    expect(text).toContain('Context cost by region');
    expect(text).toMatch(/at launch\s+locations\s+region/);
    // A zero here means the always-loaded lane stopped resolving: this
    // repository has a root CLAUDE.md and several nested ones.
    expect(text).toMatch(/Region .+ — [\d,]+ tokens at launch/);
  });

  it('emits NO per-path answer blocks — that is what naming paths is for', () => {
    expect(text).not.toContain(PER_PATH_HEADING);
    expect(text).not.toContain('DIRECTORY query —');
    expect(text).not.toContain('FILE query —');
  });

  it('states the limits EXACTLY ONCE across the whole map', () => {
    const occurrences = text.split(LIMITS_HEADING).length - 1;

    expect(occurrences).toBe(1);
    expect(text).toContain(BOUNDS_PHRASE);
  });

  it('says how many directories it did not print, rather than capping silently', () => {
    // This repository carries hundreds of working locations, so the cap fires.
    expect(text).toMatch(/and \d+ more directories/);
  });

  it('ranks directories by what working there costs — launch plus on demand', () => {
    expect(text).toMatch(/total\s+at launch\s+on demand\s+directory/);
    // ⛔ The ORDER, checked against the shipped binary's own numbers rather than
    // against a hand-computed expectation this test has no way to derive: the
    // total column must descend. A rank on a key the producer did not sort by
    // shows up here as a column that goes back up.
    // Three right-aligned numeric columns then a path — the only line shape in
    // this report with three. The region table's rows carry two, so they cannot
    // be swept in and quietly satisfy the monotonicity claim below.
    const totals = [...text.matchAll(/^ +([\d,]+) +[\d,]+ +[\d,]+ +\S/gmu)]
      .map((match) => Number((match[1] ?? '').replaceAll(',', '')));

    expect(totals.length).toBeGreaterThan(1);
    expect([...totals].sort((left, right) => right - left)).toEqual(totals);
  });

  it('rolls the unmeasured-row counts up to the whole tree', () => {
    // ⛔ Printed whatever the counts are. The per-region blocks are suppressed
    // when all three are zero, so this roll-up is the only thing left saying the
    // rows were counted at all — and on a fully-measured tree it is all zeros,
    // which is a measurement rather than a silence.
    expect(text).toContain('could not measure');
    expect(text).toMatch(/size unknown\s+[\d,]+ rows?/);
    expect(text).toMatch(/pruned behind a skip\s+[\d,]+ rows?/);
  });

  it('groups thousands the same way in the tables and in the row lines', () => {
    // Two spellings of one quantity in one document reads as a bug. Every
    // four-or-more-digit token count is grouped, wherever it is printed.
    expect(text).not.toMatch(/\b\d{4,} tokens\b/);
    // ⚠️ A single separator group, not `(,\d{3})+` — the repeated group is a
    // catastrophic-backtracking shape the security lint rejects, and one group
    // is all this claim needs: at least one grouped count really is printed.
    expect(text).toMatch(/\b\d{1,3},\d{3} tokens\b/);
  });

  it('never reads as a settled figure', () => {
    expect(text).not.toMatch(/total cost|all context|complete context/i);
  });

  it('emits the cost-map envelope under --format json, discriminated by kind', () => {
    expect(jsonStatus).toBe(0);
    expect(envelope.kind).toBe('context-cost-map');
    // ⛔ And carries no `answers`: the two envelopes are different documents, not
    // one document with an optional half.
    expect(envelope.answers).toBeUndefined();
    expect(envelope.costMap?.regions?.length).toBeGreaterThan(0);
    expect(envelope.costMap?.directories?.length).toBeGreaterThan(0);
    expect(envelope.costMap?.evaluatedDirectories).toBeGreaterThan(0);
  });

  it('carries the limits on the ENVELOPE and on no region', () => {
    expect(envelope.boundsStatement).toContain(BOUNDS_PHRASE);
    expect(envelope.limits?.find((limit) => limit.id === 'cliff-scope')?.direction).toBe('scope');
    expect(envelope.modelledBehaviours?.length).toBeGreaterThan(0);

    for (const region of envelope.costMap?.regions ?? []) {
      expect('limits' in region).toBe(false);
      expect('boundsStatement' in region).toBe(false);
    }
  });

  it('documents what --all now produces', async () => {
    const result = await executeCli(context.binPath, ['claude', 'context', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cost map');
    // The old sentence is now false and must not survive in the manual.
    expect(result.stdout).not.toContain('sweeps every path the projection realized');
  });
});
