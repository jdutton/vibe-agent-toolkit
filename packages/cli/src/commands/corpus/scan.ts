/**
 * `vat corpus scan [seed-file] --out <dir>` — Phase 1 orchestrator.
 *
 * Reads the seed, delegates each entry to the runner sequentially,
 * writes summary.yaml and per-plugin sibling files into a date-sha
 * subdirectory of `--out`. Sequential by design — concurrency is a
 * follow-up once the seed grows past ~50.
 *
 * Its stdout is the run's own report (`CORPUS_SCAN_REPORT_SCHEMA`): one row
 * per seed entry, and one `CORPUS_ENTRY_INCOMPLETE` warning per entry it could
 * not finish — so the exit derives 0 whatever the plugins held, and a scan
 * that could not do an entry never publishes `ok`. The files under `--out` are
 * artifacts through the same writer (`corpus-audit`, `corpus-summary`).
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport, toFindings, type Gate, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGit } from '@vibe-agent-toolkit/utils/git';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, type FinishedWork } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';

import { writeRunOutput, writeRunReport, type PluginRow, type RunReport } from './report.js';
import { auditOnePlugin } from './runner.js';
import type { CorpusScanData } from './scan-schema.js';
import { loadSeedFile } from './seed.js';

export interface CorpusScanOptions {
  out?: string;
  withReview?: boolean;
  debug?: boolean;
}

const DEFAULT_SEED_PATH = 'corpus/seed.yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVatVersion(): string {
  // packages/cli/dist/commands/corpus/scan.js → packages/cli/package.json
  // packages/cli/src/commands/corpus/scan.ts → packages/cli/package.json
  const pkgPath = safePath.resolve(__dirname, '../../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

/**
 * The commit of **VAT itself**, for the scan's provenance header.
 *
 * Asked at VAT's own package root, the same way {@link readVatVersion} resolves
 * its `package.json`. Running with no `cwd` asked `process.cwd()` instead — the
 * *scanned project*, not vat — so an installed vat stamped the adopter's HEAD
 * under the name `vatCommit`, and an installed vat has no commit to report at
 * all. The environment is scrubbed for the same reason the path is pinned: an
 * inherited `GIT_DIR` overrides `cwd` and answers for a third repository again.
 *
 * @returns The short commit SHA, or `'unknown'` when vat is not in a checkout
 */
function readVatCommit(): string {
  const result = runGit(['rev-parse', '--short=8', 'HEAD'], {
    cwd: safePath.resolve(__dirname, '../../..'),
  });
  return result.ok ? result.stdout : 'unknown';
}

/** `vat corpus scan` has no `--strict`: an incomplete entry warns, and a warning never fails the run. */
const GATE: Gate = { strict: false };

/** Why a row is unfinished — its audit could not run, or its requested review did not finish — or `undefined`. */
function unfinishedReason(row: PluginRow): string | undefined {
  if (row.audit.status === 'unloadable') return `audit could not run: ${row.audit.error ?? 'no reason recorded'}`;
  if (row.review.status === 'error') return `review did not finish: ${row.review.error ?? 'no reason recorded'}`;
  return undefined;
}

/** One seed entry the scan could not finish, as a finding naming it by its seed index. */
function incompleteEntryIssue(row: PluginRow, index: number): ValidationIssue | undefined {
  const why = unfinishedReason(row);
  if (why === undefined) return undefined;
  return { code: 'CORPUS_ENTRY_INCOMPLETE', severity: 'warning', message: `${row.name}: ${why}`, field: `plugins[${index}]` };
}

/** Where one run's files go: the resolved `--out`, and the run directory under it. */
interface RunLocation {
  readonly outDir: string;
  readonly runDirName: string;
}

/** What a scan has done so far — read by the refusal path, so a failure part-way keeps the finished entries. */
interface ScanProgress {
  readonly rows: PluginRow[];
  run: RunLocation | undefined;
}

/**
 * The work a scan has finished: one row per entry done, `outputPath` relative
 * to `outDir`. Also what a refusal part-way publishes, so the entries that
 * finished are not lost with the one that stopped the run.
 *
 * @param rows - The rows finished so far
 * @param run - Where the run's files went
 */
function finishedScan(rows: readonly PluginRow[], run: RunLocation): FinishedWork & { data: CorpusScanData } {
  return {
    examined: rows.length,
    findings: toFindings(rows.flatMap((row, index) => incompleteEntryIssue(row, index) ?? [])),
    data: {
      outDir: run.outDir,
      entries: rows.map((row) => ({
        name: row.name,
        audit: row.audit.status,
        review: row.review.status,
        outputPath: row.audit.output_path === undefined ? null : toForwardSlash(safePath.join(run.runDirName, row.audit.output_path)),
      })),
    },
  };
}

/**
 * Audit every seed entry and write the run's files, recording each finished
 * row in `progress` as it lands.
 *
 * @returns Where the run's files went
 * @throws {CommandRefusalError} For a missing `--out`, a seed that cannot be
 *   loaded, or a write under `--out` the OS refused
 */
async function scanSeed(
  seedFileArg: string | undefined,
  options: CorpusScanOptions,
  logger: Logger,
  progress: ScanProgress,
): Promise<RunLocation> {
  // Spec §7: `vat corpus *` uses `tolerate null` — scans operate against
  // arbitrary external plugins without requiring a governing VAT project.
  projectRootOrNull(process.cwd());

  if (!options.out) {
    throw new CommandRefusalError('USAGE_INVALID', 'specify an output directory: --out <path>');
  }
  const outDir = safePath.resolve(options.out);

  const seedPath = seedFileArg ?? DEFAULT_SEED_PATH;
  const seed = loadSeedFile(seedPath);

  // eslint-disable-next-line local/no-fs-mkdirSync -- caller-supplied output dir; recursive create is correct here
  writeRunOutput(outDir, () => mkdirSync(outDir, { recursive: true }));

  // We need the run directory to write per-plugin files into during the
  // loop. Build the report skeleton, derive the run dir name, create it,
  // then run the loop.
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const vatVersion = readVatVersion();
  const vatCommit = readVatCommit();
  const runDirName = `${generatedAt.slice(0, 10)}-${vatCommit}`;
  const runDir = safePath.join(outDir, runDirName);
  // eslint-disable-next-line local/no-fs-mkdirSync -- composed under user-supplied --out
  writeRunOutput(runDir, () => mkdirSync(runDir, { recursive: true }));
  progress.run = { outDir, runDirName };

  for (const entry of seed.plugins) {
    logger.info(`[${entry.name}] auditing ${entry.source}`);
    const row = await auditOnePlugin(entry, {
      runDir,
      withReview: options.withReview === true,
      debug: options.debug === true,
    });
    progress.rows.push(row);
    logger.info(`[${entry.name}] audit=${row.audit.status} review=${row.review.status}`);
  }

  const report: RunReport = {
    generated_at: generatedAt,
    vat_version: vatVersion,
    vat_commit: vatCommit,
    seed_file: seedPath,
    flags: {
      with_review: options.withReview === true,
      debug: options.debug === true,
    },
    plugins: progress.rows,
  };

  await writeRunReport(report, outDir);

  logger.info(`Wrote run report to ${runDir}/summary.yaml`);
  logger.info(`  ${progress.rows.length} plugins; durations recorded in summary.yaml`);
  return progress.run;
}

export async function corpusScanCommand(
  seedFileArg: string | undefined,
  options: CorpusScanOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const progress: ScanProgress = { rows: [], run: undefined };

  let run: RunLocation;
  try {
    run = await scanSeed(seedFileArg, options, logger, progress);
  } catch (err) {
    // A refusal after the run directory existed publishes the entries that finished.
    const finished = progress.run === undefined ? NOTHING_FINISHED : finishedScan(progress.rows, progress.run);
    endWithRefusal('corpus scan', refusalCodeOf(err), err, 'yaml', GATE, finished);
  }
  const { examined, findings, data } = finishedScan(progress.rows, run);
  endWithReport('corpus scan', buildReport({ examined, findings, data, gate: GATE, durationMs: Date.now() - startTime }), 'yaml');
}
