/**
 * `vat pipeline` — the QA snapshot instrument's command group.
 *
 * Wiring only: every flag declared here is parsed and handed to a handler in
 * `./snapshot.js`, `./compare.js` or `./check.js`. The numeric parsers live here
 * because Commander is what needs them, and because a bad `--timeout` should
 * fail at parse time with the flag named rather than inside a capture.
 *
 * **Not hidden from `--help`.** The intended caller is an agent session driving
 * this from a terminal, and a hidden verb is undiscoverable by exactly that
 * caller. The absence of API stability is stated in the group description and
 * again in its help text instead.
 */

import { Command, InvalidArgumentError } from 'commander';

import { pipelineCheckCommand, type PipelineCheckOptions } from './check.js';
import {
  DEFAULT_DIFF_CONTEXT,
  DEFAULT_DIFF_MAX_LINES,
  pipelineCompareCommand,
  type PipelineCompareOptions,
} from './compare.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  LANE_ID_LIST,
  pipelineSnapshotCommand,
  type PipelineSnapshotOptions,
} from './snapshot.js';

/** Repeated flag spellings and descriptions, hoisted so no literal repeats. */
const LANE_FLAG = '--lane <id...>';
const LANE_DESC = `Restrict to one or more enumeration lanes (repeatable). Valid: ${LANE_ID_LIST}`;
const DEBUG_FLAG = '--debug';
const DEBUG_DESC = 'Enable debug logging';
const CORPUS_ARG_DESC = 'Corpus directory to capture (default: the current directory)';

/**
 * A Commander argument parser for a whole number at or above a floor.
 *
 * @param flag - Flag spelling, so the error names the option the user typed
 * @param floor - Smallest value that makes sense for this flag
 * @returns A parser Commander calls with the raw string
 */
function wholeNumberAtLeast(flag: string, floor: number): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < floor) {
      throw new InvalidArgumentError(
        `${flag} expects a whole number of at least ${String(floor)}; got '${value}'.`,
      );
    }
    return parsed;
  };
}

/**
 * Build the `vat pipeline` command group.
 *
 * @returns The configured Commander command, ready for `program.addCommand`
 */
export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline');

  pipeline
    .description(
      'Internal dev instrument: hold the resource pipeline still across a refactor (NO API stability)',
    )
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  Captures what VAT's resource pipeline actually enumerates and parses over a
  corpus, so a refactor can be shown to have moved it — or not to have.
  'snapshot' captures five enumeration lanes, a parse-fact oracle and three
  whole-command runs; 'compare' reports what moved between two captures;
  'check' asserts the pipeline's internal invariants without spawning anything.

  Typical use: snapshot before, refactor, snapshot after with --compare.

NO API STABILITY — this is an instrument, not a product surface:
  The lanes bind to internal builders (createProjectRegistry,
  crawlAndResolveRegistry, and friends). Those move whenever the pipeline
  moves, which is the entire point of the instrument. Nothing outside this
  repository may depend on the output shape, the artifact names or the
  on-disk snapshot layout. All three change without notice, without a
  deprecation cycle and without a CHANGELOG entry.

  It is deliberately NOT hidden from --help: its intended caller is an agent
  session driving it from a terminal, and a hidden verb is undiscoverable by
  exactly that caller.

Example:
  $ vat pipeline snapshot . --out /tmp/vat-after --compare /tmp/vat-before
`,
    );

  addSnapshotCommand(pipeline);
  addCompareCommand(pipeline);
  addCheckCommand(pipeline);

  return pipeline;
}

/**
 * Register `vat pipeline snapshot`.
 *
 * @param pipeline - The group to register on
 * @returns Nothing
 */
function addSnapshotCommand(pipeline: Command): void {
  pipeline
    .command('snapshot')
    .description('Capture a QA snapshot of the pipeline over a corpus into --out')
    .argument('[dir]', CORPUS_ARG_DESC)
    // .option, NOT .requiredOption: Commander's own missing-required-option
    // error exits 1, and 1 is documented below as "something changed". The
    // handler enforces --out and fails through handleCommandError, so a missing
    // --out exits 2 like every other refusal.
    .option('--out <dir>', 'REQUIRED. Directory to write the snapshot into (no default — it is replaced wholesale)')
    .option('--compare <dir>', 'After capturing, compare against this snapshot directory as the BEFORE side')
    .option(LANE_FLAG, LANE_DESC)
    .option('--no-commands', 'Skip the whole-command half (spawns nothing; needs no built binary)')
    .option('--no-parse-facts', 'Skip the parse-fact oracle (the slowest oracle on a large corpus)')
    .option('--label <s>', 'Short corpus label printed into the oracle artifacts (default: the corpus directory name)')
    .option(
      '--timeout <ms>',
      'Millisecond ceiling per spawned command',
      wholeNumberAtLeast('--timeout <ms>', 1),
      DEFAULT_COMMAND_TIMEOUT_MS,
    )
    .option(DEBUG_FLAG, DEBUG_DESC)
    .action(async function (this: Command, dir: string | undefined) {
      await pipelineSnapshotCommand(dir, this.optsWithGlobals() as PipelineSnapshotOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Captures both halves of a QA snapshot over [dir] and writes them to --out.
  The oracle half runs the five enumeration lanes and the parse-fact oracle
  in-process; the whole-command half spawns 'resources scan', 'resources
  validate --format json' and 'audit', keeping both streams with the corpus,
  VAT and home directory roots scrubbed out.

  --out is REPLACED, not merged. An artifact left behind by an earlier
  capture would read to a later 'compare' as unchanged, which is the one
  answer this instrument must never invent. A non-empty directory holding no
  manifest.json is refused rather than overwritten.

  --compare <dir> is sugar: capture into --out, then run exactly the
  comparison 'vat pipeline compare <dir> <out>' would run, with <dir> as the
  BEFORE side and this fresh capture as AFTER.

Output:
  Without --compare: a YAML summary on stdout —
    status, out, corpus, lanes, commands, artifacts, warnings, duration
  With --compare: the plain-text comparison summary on stdout, and the exit
  codes below.

  'warnings' are capture-time constraints on any later reading: a lane
  answered by the filesystem walk rather than git (its ORDERING is not
  comparable across hosts), a lane whose builder threw, a half you skipped.

Exit Codes:
  0 - snapshot written (with --compare: written, and nothing changed)
  1 - with --compare only: something changed
  2 - refused or system error (unknown --lane, unwritable --out, a
      formatVersion mismatch against --compare)

Example:
  $ vat pipeline snapshot . --out /tmp/vat-after --compare /tmp/vat-before
`,
    );
}

/**
 * Register `vat pipeline compare`.
 *
 * @param pipeline - The group to register on
 * @returns Nothing
 */
function addCompareCommand(pipeline: Command): void {
  pipeline
    .command('compare')
    .description('Report what moved between two snapshot directories')
    .argument('<before>', 'Snapshot directory captured first')
    .argument('<after>', 'Snapshot directory captured second')
    .option('--detail <selector>', 'Print the diff for one artifact by name instead of the summary')
    .option(
      '--max-lines <n>',
      'Cap on diff lines printed under --detail',
      wholeNumberAtLeast('--max-lines <n>', 1),
      DEFAULT_DIFF_MAX_LINES,
    )
    .option(
      '--context <n>',
      'Unchanged lines kept around each diff hunk',
      wholeNumberAtLeast('--context <n>', 0),
      DEFAULT_DIFF_CONTEXT,
    )
    .option(DEBUG_FLAG, DEBUG_DESC)
    .action(function (this: Command, before: string, after: string) {
      pipelineCompareCommand(before, after, this.optsWithGlobals() as PipelineCompareOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  The default output is one line per artifact and nothing more. That is the
  design: 'vat audit' alone emits 1.81 MB of YAML carrying 1,755 findings, so
  printing diff text by default would rebuild the exact problem this
  instrument exists to solve. Name one artifact with --detail to see its
  diff.

  Both sides' capture-time warnings are echoed above the summary. A
  comparison read without them can be actively misleading.

  A formatVersion mismatch is REFUSED, never attempted: the artifact sets are
  not the same shape, and a comparison of nothing renders as "nothing
  changed" — a reader would conclude a refactor moved nothing when in fact
  nothing was compared. Refusal exits 2, not 0.

Output:
  Plain text on stdout. Constraint lines are stably prefixed and greppable:
    REFUSED:  no comparison was attempted (exit 2)
    MASKED:   the content-key column was masked on both sides before comparing
    CORPUS:   the two captures may not describe the same corpus
    PLATFORM: a walk-route lane compared across platforms; ordering is not portable
    ADDED: / REMOVED: an artifact exists on one side only
  Only REFUSED: changes the exit code; the rest narrow what the result means.

  --detail selectors are the artifact names in the first column:
    enumeration.<laneId>   parse-facts
    command.<name>.stdout  command.<name>.stderr
  A selector that matches nothing prints the available list and exits 2 — it
  must not exit 0 having shown you nothing.

Exit Codes:
  0 - every artifact identical
  1 - at least one artifact changed
  2 - refused, --detail matched nothing, or a system error (not a snapshot
      directory, or a manifest naming an artifact that is not on disk)

Example:
  $ vat pipeline compare /tmp/vat-before /tmp/vat-after --detail enumeration.resources
`,
    );
}

/**
 * Register `vat pipeline check`.
 *
 * @param pipeline - The group to register on
 * @returns Nothing
 */
function addCheckCommand(pipeline: Command): void {
  pipeline
    .command('check')
    .description("Assert the pipeline's internal invariants over a corpus (spawns nothing)")
    .argument('[dir]', CORPUS_ARG_DESC)
    .option(LANE_FLAG, LANE_DESC)
    .option(DEBUG_FLAG, DEBUG_DESC)
    .action(async function (this: Command, dir: string | undefined) {
      await pipelineCheckCommand(dir, this.optsWithGlobals() as PipelineCheckOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Captures the oracle half over [dir] with the whole-command half switched
  off — nothing is spawned and no built binary is needed — then asserts three
  invariants:

    restatementDriftCount == 0 (per lane)
      pipeline-oracles/lanes.ts still describes the builders it claims to.
      Drift means every artifact that lane produced is a fiction about a
      crawl that did not happen.

    parseFactKeyDisagreementCount == 0
      No two paths share a content key and parse differently. Non-zero means
      a content-addressed cache over this pipeline would be unsound.

    no lane reports a buildError
      Each lane's production builder ran. A lane that threw reports 0
      admitted and 0 collisions because nothing ran, not because the corpus
      is empty.

  Duplicate-id collisions are reported as INFORMATION, never as a violation.
  They are real and pre-existing, and failing on them would make this check
  red on VAT's own repository from day one.

  Not checked here: the MISSING_PATH and UNRESOLVED_SYMLINK codes exist in
  the violation vocabulary but no invariant above produces them.

Output:
  A YAML document on stdout: status, corpus, lanesChecked, violationCount,
  parseFactBlobCount, duplicateIdCollisions, captureWarnings, violations,
  duration. Each violation carries laneId, code (BUILD_ERROR,
  RESTATEMENT_DRIFT, KEY_DISAGREEMENT) and detail.

Exit Codes:
  0 - every invariant holds
  1 - at least one violation
  2 - system error (unknown --lane, unreadable corpus)

Example:
  $ vat pipeline check .
`,
    );
}
