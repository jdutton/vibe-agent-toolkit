/**
 * Time a rival markdown parser against the one VAT uses, on a real corpus.
 *
 * ## Why this exists, and what decision it settles
 *
 * `remark-parse` is 83% of VAT's markdown parse time and 64% of a cold
 * `resources validate` wall, and the tokenize/tree-build split
 * (`VAT_PARSE_TIMING_SPLIT`) showed roughly 76% of it is micromark TOKENIZING.
 * That kills the "drive micromark directly and skip mdast" option — its whole
 * ceiling is the other 24% — and leaves exactly one lever: a different parser.
 * Nobody had benchmarked one. This does, on the corpus VAT actually parses.
 *
 * ## Why this is not a lab facet
 *
 * The lab's boundary question is "does this need vat's internals, or only vat's
 * command line?", and it exists to compare *which project, which version of it,
 * which vat build*. A rival library is none of those axes, and the answer has no
 * life after the decision it informs. So it lives here, where it is committed,
 * reviewed and reproducible but ships to nobody — rather than as a throwaway
 * script, which measures once and dies with the session.
 *
 * ## What makes the comparison honest
 *
 * - **The population is VAT's, not a glob's.** `vat resources scan --verbose`
 *   names the files, so ignore rules and the projection lane are respected. A
 *   plain `find` over the same tree returns 1,594 markdown files against VAT's
 *   1,266 — a 26% larger corpus that would silently be a different measurement.
 * - **Each processor is imported, never rebuilt.** `createMarkdownProcessor()`
 *   gives the remark arm `remark-gfm` and `remark-frontmatter` exactly as
 *   production does, and `createMarkdownItProcessor()` gives the rival arm the
 *   configuration the conformance adapter is judged on — raw HTML, frontmatter
 *   and the two rule wrappers included. A rival benchmarked against a thinner
 *   processor is a rival handed less work, and the ratio is then wrong in the
 *   direction that flatters it.
 * - ⭐ **Each arm runs in its OWN process.** The first shape of this tool ran
 *   both arms in one process and the two orders disagreed by 65% — 15.1x one
 *   way, 9.2x the other, off a remark arm that swung 22.1s to 13.1s. Two causes,
 *   both fatal to a shared process: JIT warm-up, and a heap carrying the other
 *   arm's garbage. The second is not symmetric — remark allocates an mdast tree
 *   per document where `markdown-it` allocates a flat token array — so shared-
 *   heap pressure penalises remark specifically, in the direction that flatters
 *   the rival. A fresh process per arm removes both, and a warm-up pass inside
 *   each child removes what is left.
 * - **The reported figure is the MINIMUM of several passes**, for the reason the
 *   lab's own `fastestRepeat` takes a minimum: a median carries whichever pass
 *   happened to land in the middle, so one interrupted pass survives into the
 *   number being compared. Every sample is printed, so the spread is visible.
 * - **Both orders are still run.** Separate processes cannot cancel OS file-
 *   cache warmth, and agreement between the orders is what retires that caveat
 *   with a number instead of a hedge.
 *
 * ## What it deliberately does NOT claim
 *
 * ⚠️ **This measures speed, not equivalence.** VAT's job is link and reference
 * integrity, so any parser change moves RESULTS, not just milliseconds. Without
 * a facts diff you cannot tell *faster* from *differently wrong*, and
 * differently-wrong ships silently. That diff is `parse-conformance.ts`, and a
 * favourable ratio here is a reason to read its report — never a reason to swap
 * a parser on its own.
 *
 * ## Two stages, because a parser's output is not what VAT consumes
 *
 * `--stage parse` (the default) times the parser's own output — an mdast tree
 * on one side, a flat token array on the other. That is the number a library
 * comparison usually quotes, and on its own it is not a number anyone can act
 * on: neither arm has yet paid for the walk that turns that output into
 * `ParseFacts`, and those walks are not the same size.
 *
 * `--stage facts` times `parseMarkdownContent` instead — the whole composer,
 * capability adapter and VAT's own derivations included. That is what a swap
 * would actually buy, so it is the stage a decision should quote. The two are
 * run separately rather than nested because the difference between them is the
 * point, and a single blended figure hides it.
 *
 * ⚠️ Still speed, still not equivalence. `parse-conformance.ts` is the harness
 * that answers whether the two arms agree; this one only says how fast they
 * disagree.
 *
 * ## Running it
 *
 * ```
 * bun run bakeoff:parsers <corpus-path> [--stage parse|facts] [--expect-files N]
 *                                       [--expect-bytes N] [--rounds N]
 * ```
 *
 * The expectations are how a run refuses a corpus it was not calibrated
 * against: a cross-run comparison against a different population is not a
 * comparison at all.
 */

import { readFile } from 'node:fs/promises';

// The subpath, not the barrel: the barrel is loaded by commands that must never
// pay for the parser, so it deliberately does not re-export this.
import { parseMarkdownContent } from '@vibe-agent-toolkit/resources/link-parser';
import { createMarkdownProcessor } from '@vibe-agent-toolkit/resources/markdown-processor';
import { safePath } from '@vibe-agent-toolkit/utils';
import { safeExecResult } from '@vibe-agent-toolkit/utils/process';

import { getFilename, log, PROJECT_ROOT } from './common.js';
// The rival arm's configuration lives with the rival's adapter, exactly as the
// remark arm's lives with remark's. Importing it is what makes the speed verdict
// and the fidelity verdict statements about the same parser.
import { createMarkdownItProcessor, markdownItParser } from './markdown-it-parser.js';

/** One corpus document, read once and parsed by whichever arm this process is. */
interface Document {
  readonly content: string;
  readonly bytes: number;
}

/** The two arms, by the name they carry on the command line and in the table. */
export const ARMS = ['remark-parse', 'markdown-it'] as const;

/** One of {@link ARMS}. */
export type ArmName = (typeof ARMS)[number];

/** The reference arm, named once so a pass cannot branch on a misspelled literal. */
const [REMARK_ARM] = ARMS;

/**
 * How far down the pipeline a pass runs — see this module's docstring.
 *
 * `parse` is the parser's own output; `facts` is `parseMarkdownContent`, which
 * is what VAT actually consumes and therefore what a swap would actually buy.
 */
export const STAGES = ['parse', 'facts'] as const;

/** One of {@link STAGES}. */
export type StageName = (typeof STAGES)[number];

/** What each stage includes, printed above the table so a number is not read bare. */
const STAGE_DESCRIPTIONS: Readonly<Record<StageName, string>> = {
  parse: "the parser's own output, no capability adapter",
  facts: 'the whole composer, adapter and derivations included',
};

/** What a child process prints on stdout. */
export interface ArmReport {
  readonly arm: ArmName;
  /** Carried so a report cannot be read as the stage it is not. */
  readonly stage: StageName;
  readonly documents: number;
  readonly bytes: number;
  readonly samples: readonly number[];
}

/** The vat binary this repo builds — the same one the lab measures. */
const VAT_BIN = safePath.join(PROJECT_ROOT, 'packages/cli/dist/bin/vat.js');

/** Timed passes per child, on top of one untimed warm-up. */
const DEFAULT_ROUNDS = 3;

/** The single instance this bake-off times, so allocation is not in the sample. */
const markdownIt = createMarkdownItProcessor();

/**
 * Read one CLI flag's value as a number.
 *
 * @param argv - The arguments after the corpus path
 * @param flag - The flag to look for, including its dashes
 * @returns The value, or `null` when the flag is absent
 */
export function numericFlag(argv: readonly string[], flag: string): number | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const raw = argv[index + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new Error(`${flag} needs a number, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Read one CLI flag's value as a string.
 *
 * @param argv - The arguments after the corpus path
 * @param flag - The flag to look for, including its dashes
 * @returns The value, or `null` when the flag is absent
 */
function stringFlag(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/** What `vat resources scan --format json --verbose` publishes, as far as this cares. */
interface ScanReport {
  readonly root: string;
  readonly files?: readonly { readonly path: string }[];
}

/**
 * Ask vat which files it would parse, and read them.
 *
 * Going through the CLI rather than importing a crawler is the point: the
 * population then includes every ignore rule, every config default and whichever
 * enumeration lane vat chose, none of which this tool has to know about.
 *
 * @param corpus - The project to scan
 * @returns Every markdown document, content already read
 */
async function readCorpus(corpus: string): Promise<Document[]> {
  const scan = safeExecResult('node', [
    VAT_BIN,
    'resources',
    'scan',
    corpus,
    '--format',
    'json',
    '--verbose',
  ]);
  if (!scan.success) {
    throw new Error(`vat resources scan failed for ${corpus}: ${String(scan.stderr) || String(scan.stdout)}`);
  }
  const report = JSON.parse(String(scan.stdout)) as ScanReport;
  const markdown = (report.files ?? []).filter((file) => file.path.endsWith('.md'));

  return Promise.all(
    markdown.map(async (file) => {
      const absolute = safePath.join(report.root, file.path);
      // Read bytes and decode, rather than asking for a string: `bytes` is then
      // the file's real on-disk length, which is what the corpus check compares
      // against vat's own byte figure.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from vat's own scan of the corpus under measurement
      const raw = await readFile(absolute);
      return { content: raw.toString('utf-8'), bytes: raw.byteLength };
    }),
  );
}

/**
 * Parse every document once with the named arm, stopping at the parser.
 *
 * remark builds a fresh processor per document exactly as `parseMarkdownContent`
 * does. `markdown-it` uses `parse` — not `render` — because the token stream is
 * the stage a fact collector would consume and the fair counterpart to mdast;
 * rendering HTML would measure work VAT would never do.
 *
 * @param arm - Which parser to run
 * @param documents - The corpus
 */
function parsePass(arm: ArmName, documents: readonly Document[]): void {
  if (arm === REMARK_ARM) {
    for (const document of documents) createMarkdownProcessor().parse(document.content);
    return;
  }
  for (const document of documents) markdownIt.parse(document.content, {});
}

/**
 * Produce `ParseFacts` for every document with the named arm.
 *
 * The same composer both arms would run in production, so this carries each
 * one's capability adapter — remark's filtered tree walk, `markdown-it`'s line
 * starts and token-stream walk — plus VAT's own derivations, which are shared
 * and therefore dilute the ratio rather than distorting it.
 *
 * @param arm - Which parser to run
 * @param documents - The corpus
 */
function factsPass(arm: ArmName, documents: readonly Document[]): void {
  if (arm === REMARK_ARM) {
    // No third argument: remark IS the default, so this is the production path
    // rather than a reconstruction of it.
    for (const document of documents) parseMarkdownContent(document.content, document.bytes);
    return;
  }
  for (const document of documents) parseMarkdownContent(document.content, document.bytes, markdownItParser);
}

/**
 * One timed pass, at the requested stage.
 *
 * @param arm - Which parser to run
 * @param stage - How far down the pipeline to go
 * @param documents - The corpus
 */
function runPass(arm: ArmName, stage: StageName, documents: readonly Document[]): void {
  if (stage === 'facts') factsPass(arm, documents);
  else parsePass(arm, documents);
}

/**
 * Child mode: warm up, time `rounds` passes, print the report as JSON.
 *
 * @param arm - Which parser this process is
 * @param corpus - The project to scan
 * @param rounds - Timed passes after the warm-up
 * @param stage - How far down the pipeline each pass goes
 */
async function runArm(arm: ArmName, corpus: string, rounds: number, stage: StageName): Promise<void> {
  const documents = await readCorpus(corpus);
  runPass(arm, stage, documents);

  const samples: number[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const startedAt = performance.now();
    runPass(arm, stage, documents);
    samples.push(performance.now() - startedAt);
  }

  const report: ArmReport = {
    arm,
    stage,
    documents: documents.length,
    bytes: documents.reduce((sum, document) => sum + document.bytes, 0),
    samples,
  };
  process.stdout.write(JSON.stringify(report));
}

/**
 * Run one arm in a fresh process.
 *
 * @param arm - Which parser to measure
 * @param corpus - The project to scan
 * @param rounds - Timed passes the child should take
 * @param stage - How far down the pipeline each pass goes
 * @returns What the child measured
 */
function spawnArm(arm: ArmName, corpus: string, rounds: number, stage: StageName): ArmReport {
  const child = safeExecResult('bunx', [
    'tsx',
    getFilename(import.meta.url),
    corpus,
    '--arm',
    arm,
    '--rounds',
    String(rounds),
    '--stage',
    stage,
  ]);
  if (!child.success) {
    throw new Error(`${arm} arm failed: ${String(child.stderr) || String(child.stdout)}`);
  }
  return JSON.parse(String(child.stdout)) as ArmReport;
}

/**
 * Refuse a corpus that is not the one the caller calibrated against.
 *
 * @param report - What an arm measured, carrying the population it saw
 * @param argv - The arguments carrying the expectations
 */
export function checkCorpus(report: ArmReport, argv: readonly string[]): void {
  const expectedFiles = numericFlag(argv, '--expect-files');
  const expectedBytes = numericFlag(argv, '--expect-bytes');

  if (expectedFiles !== null && report.documents !== expectedFiles) {
    throw new Error(`expected ${expectedFiles} markdown files, found ${report.documents}`);
  }
  if (expectedBytes !== null && report.bytes !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, found ${report.bytes}`);
  }
}

/** One arm's best pass and its spread, ready to print. */
export interface ArmSummary {
  readonly arm: ArmName;
  readonly minMs: number;
  readonly samples: readonly number[];
}

/**
 * Take the best pass an arm managed across every process that ran it.
 *
 * @param reports - Every report for this arm, across both orders
 * @param arm - Which arm
 * @returns Its minimum and the samples behind it
 */
export function summarise(reports: readonly ArmReport[], arm: ArmName): ArmSummary {
  const samples = reports.filter((report) => report.arm === arm).flatMap((report) => report.samples);
  if (samples.length === 0) throw new Error(`no samples for ${arm}`);
  return { arm, minMs: Math.min(...samples), samples };
}

/**
 * Parent mode: run both arms in both orders and print the table.
 *
 * @param corpus - The project to scan
 * @param argv - The arguments after the corpus path
 */
function runBakeoff(corpus: string, argv: readonly string[]): void {
  const rounds = numericFlag(argv, '--rounds') ?? DEFAULT_ROUNDS;
  const stage = requireStage(argv);
  const [first, second] = ARMS;

  const reports = [
    spawnArm(first, corpus, rounds, stage),
    spawnArm(second, corpus, rounds, stage),
    spawnArm(second, corpus, rounds, stage),
    spawnArm(first, corpus, rounds, stage),
  ];
  const population = reports[0];
  if (population === undefined) throw new Error('no arm produced a report');
  checkCorpus(population, argv);

  const remark = summarise(reports, first);
  const rival = summarise(reports, second);

  log(
    `Corpus: ${population.documents} markdown documents, ${population.bytes.toLocaleString()} bytes`,
    'cyan',
  );
  log(`Stage: ${stage} — ${STAGE_DESCRIPTIONS[stage]}`, 'cyan');
  log(`Each arm ran in its own process, twice, ${rounds} timed passes each after a warm-up.`, 'cyan');
  log('', 'reset');
  for (const summary of [remark, rival]) {
    const perDocument = summary.minMs / population.documents;
    log(`  ${summary.arm.padEnd(13)} ${summary.minMs.toFixed(1)}ms best  (${perDocument.toFixed(3)} ms/doc)`, 'reset');
    log(`    samples: ${summary.samples.map((sample) => sample.toFixed(1)).join(', ')}`, 'reset');
  }
  log('', 'reset');
  log(`  ${first} / ${second} = ${(remark.minMs / rival.minMs).toFixed(2)}x  (stage: ${stage})`, 'yellow');
  log('', 'reset');
  log(
    'Speed only. Which facts each arm can supply is `parse-conformance.ts`, and it is the question that decides.',
    'yellow',
  );
  if (stage === 'parse') {
    log('A parse-stage ratio is not what a swap buys. Re-run with --stage facts before quoting one.', 'yellow');
  }
}

/**
 * The stage the caller asked for, defaulting to the parser's own output.
 *
 * @param argv - The arguments after the corpus path
 * @returns The stage to run
 * @throws Error when the flag names something that is not a stage
 */
export function requireStage(argv: readonly string[]): StageName {
  const stage = stringFlag(argv, '--stage');
  // `stringFlag` returns null both for an absent flag and for one with nothing
  // after it, and those must not mean the same thing: a bare `--stage` is a
  // caller who meant to choose and is about to read the other stage's number.
  if (stage === null && !argv.includes('--stage')) return 'parse';
  if (stage === null || !STAGES.includes(stage as StageName)) {
    throw new Error(`--stage must be one of ${STAGES.join(', ')}, not ${JSON.stringify(stage)}`);
  }
  return stage as StageName;
}

/**
 * Entry point: child mode when `--arm` names one, parent mode otherwise.
 */
async function main(): Promise<void> {
  const [corpus, ...argv] = process.argv.slice(2);
  if (corpus === undefined) {
    throw new Error(
      'usage: bun run bakeoff:parsers <corpus-path> [--stage parse|facts] [--expect-files N] [--expect-bytes N] [--rounds N]',
    );
  }

  const arm = stringFlag(argv, '--arm');
  if (arm === null) {
    runBakeoff(corpus, argv);
    return;
  }
  if (!ARMS.includes(arm as ArmName)) {
    throw new Error(`--arm must be one of ${ARMS.join(', ')}, not ${JSON.stringify(arm)}`);
  }
  await runArm(arm as ArmName, corpus, numericFlag(argv, '--rounds') ?? DEFAULT_ROUNDS, requireStage(argv));
}

// Guarded, because this module is also imported: a unit test asserting on the
// refusal guards must not spawn a bake-off, and unguarded it would read
// vitest's own argv as a corpus path.
if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    log(`parser bake-off failed: ${error instanceof Error ? error.message : String(error)}`, 'red');
    process.exitCode = 1;
  }
}
