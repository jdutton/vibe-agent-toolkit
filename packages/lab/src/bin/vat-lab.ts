#!/usr/bin/env node
/**
 * `vat-lab` — the quality lab's command line.
 *
 * Drives vat through its command-line boundary only, which is what lets one run
 * measure two different vat versions and what lets it measure a project with no
 * vat config at all.
 */

import { parseWholeNumberAtLeast } from '@vibe-agent-toolkit/utils';
import { Command, InvalidArgumentError } from 'commander';

import { capturePerf } from '../facets/perf/capture.js';
import { comparePerf } from '../facets/perf/compare.js';
import { DEFAULT_PERF_COMMANDS } from '../facets/perf/default-commands.js';
import { renderComparison, renderReport } from '../facets/perf/render.js';
import { resolveInstrument } from '../harness/instrument.js';
import { resolveSubject } from '../harness/subject.js';
import type { InstrumentSource } from '../harness/types.js';
import { readReport, writeReport } from '../store.js';

/** Exit code used when a comparison is refused rather than merely negative. */
const EXIT_REFUSED = 2;
/** Exit code used when a comparison found a significant change. */
const EXIT_CHANGED = 1;

/**
 * Parse an instrument specifier into a source.
 *
 * The prefix is mandatory. "Guess what the user meant" is how a harness ends up
 * stamping reports with an instrument nobody asked for.
 *
 * @param value - `tree:<path>`, `dist:<path>` or `npx:<spec>`
 * @returns The parsed source
 */
export function parseInstrument(value: string): InstrumentSource {
  const separator = value.indexOf(':');
  const kind = separator === -1 ? '' : value.slice(0, separator);
  const rest = separator === -1 ? '' : value.slice(separator + 1);
  if (rest.length === 0) {
    throw new InvalidArgumentError(
      `--instrument expects 'tree:<path>', 'dist:<path>' or 'npx:<spec>'; got '${value}'.`,
    );
  }
  switch (kind) {
    case 'tree': {
      return { kind: 'tree', path: rest };
    }
    case 'dist': {
      return { kind: 'dist', path: rest };
    }
    case 'npx': {
      return { kind: 'npx', spec: rest };
    }
    default: {
      throw new InvalidArgumentError(
        `--instrument prefix must be 'tree', 'dist' or 'npx'; got '${kind}'.`,
      );
    }
  }
}

/**
 * A Commander parser for a whole number at or above a floor.
 *
 * Delegates the check to utils so the rule has one home. The wrapper exists
 * only to raise Commander's error type, which is what makes the CLI print a
 * usage message naming the flag instead of a stack trace.
 *
 * @param flag - Flag spelling, so the error names what the user typed
 * @param floor - Smallest sensible value
 * @returns A parser Commander calls with the raw string
 */
export function wholeNumberAtLeast(flag: string, floor: number): (value: string) => number {
  return (value: string): number => {
    try {
      return parseWholeNumberAtLeast(value, floor, flag);
    } catch (error) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
  };
}

/** Options Commander collects for `perf run`. */
interface PerfRunOptions {
  readonly instrument: InstrumentSource;
  readonly runs: number;
  readonly cache: string;
  readonly out: string;
  readonly id?: string;
}

/**
 * Build the `perf` command group.
 *
 * @returns The configured Commander command
 */
function createPerfCommand(): Command {
  const perf = new Command('perf').description(
    'Measure how long vat commands take, with repeats and spread',
  );

  perf
    .command('run')
    .argument('<subject>', 'Path to the project to measure')
    .requiredOption(
      '--instrument <spec>',
      "Which vat to measure: 'tree:<path>', 'dist:<path>' or 'npx:<pkg@version>'",
      parseInstrument,
    )
    .option('--runs <n>', 'Repeats per command', wholeNumberAtLeast('--runs', 1), 5)
    .option('--cache <mode>', "'warm' or 'cold' (cold clears vat's caches before every repeat)", 'warm')
    .option('--out <dir>', 'Directory to write the report into', '.vat-lab')
    .option('--id <name>', 'Subject id recorded in the report (default: the directory name)')
    .description('Capture a perf report for one project against one vat build')
    .action(async (subjectPath: string, options: PerfRunOptions) => {
      if (options.cache !== 'warm' && options.cache !== 'cold') {
        throw new InvalidArgumentError(`--cache expects 'warm' or 'cold'; got '${options.cache}'.`);
      }
      const instrument = await resolveInstrument(options.instrument);
      const subject = await resolveSubject({
        id: options.id ?? subjectPath,
        path: subjectPath,
      });
      const report = capturePerf({
        instrument,
        subject,
        commands: DEFAULT_PERF_COMMANDS,
        runs: options.runs,
        cache: options.cache,
        capturedAt: new Date().toISOString(),
      });
      const written = await writeReport(options.out, report);
      process.stdout.write(`${renderReport(report)}\nWrote ${written}\n`);
    });

  perf
    .command('compare')
    .argument('<baseline>', 'Path to the baseline report')
    .argument('<candidate>', 'Path to the report being compared against it')
    .option(
      '--allow-multi-axis',
      'Compare even when more than one axis moved (the result cannot be attributed)',
      false,
    )
    .description('Diff two perf reports along a single axis')
    .action(async (baselinePath: string, candidatePath: string, options: { allowMultiAxis: boolean }) => {
      const baseline = await readReport(baselinePath);
      if (!baseline.ok) {
        process.stderr.write(`${baseline.refusal}\n`);
        process.exitCode = EXIT_REFUSED;
        return;
      }
      const candidate = await readReport(candidatePath);
      if (!candidate.ok) {
        process.stderr.write(`${candidate.refusal}\n`);
        process.exitCode = EXIT_REFUSED;
        return;
      }
      const comparison = comparePerf(baseline.envelope, candidate.envelope, {
        allowMultiAxis: options.allowMultiAxis,
      });
      if (!comparison.ok) {
        process.stderr.write(`${comparison.refusal}\n`);
        process.exitCode = EXIT_REFUSED;
        return;
      }
      process.stdout.write(`${renderComparison(comparison)}\n`);
      if (comparison.commands.some((command) => command.verdict.kind === 'changed')) {
        process.exitCode = EXIT_CHANGED;
      }
    });

  return perf;
}

/**
 * Build the whole `vat-lab` program.
 *
 * @returns The configured root command
 */
export function createProgram(): Command {
  return new Command('vat-lab')
    .description(
      'Quality lab: report on a project and compare along one axis — which project, which version of it, which vat build',
    )
    .addCommand(createPerfCommand());
}

await createProgram().parseAsync(process.argv);
