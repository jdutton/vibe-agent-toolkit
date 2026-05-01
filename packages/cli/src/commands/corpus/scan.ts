/**
 * `vat corpus scan [seed-file] --out <dir>` — Phase 1 orchestrator.
 *
 * Reads the seed, delegates each entry to the runner sequentially,
 * writes summary.yaml and per-plugin sibling files into a date-sha
 * subdirectory of `--out`. Sequential by design — concurrency is a
 * follow-up once the seed grows past ~50.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeExecSync, safePath } from '@vibe-agent-toolkit/utils';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

import { writeRunReport, type PluginRow, type RunReport } from './report.js';
import { auditOnePlugin } from './runner.js';
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- internal package.json path
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

function readVatCommit(): string {
  try {
    const out = safeExecSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf-8' });
    return (typeof out === 'string' ? out : out.toString('utf-8')).trim();
  } catch {
    return 'unknown';
  }
}

export async function corpusScanCommand(
  seedFileArg: string | undefined,
  options: CorpusScanOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    if (!options.out) {
      throw new Error('specify an output directory: --out <path>');
    }

    const seedPath = seedFileArg ?? DEFAULT_SEED_PATH;
    const seed = loadSeedFile(seedPath);

    // eslint-disable-next-line local/no-fs-mkdirSync, security/detect-non-literal-fs-filename -- caller-supplied output dir; recursive create is correct here
    mkdirSync(options.out, { recursive: true });

    // We need the run directory to write per-plugin files into during the
    // loop. Build the report skeleton, derive the run dir name, create it,
    // then run the loop.
    const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const vatVersion = readVatVersion();
    const vatCommit = readVatCommit();
    const runDirName = `${generatedAt.slice(0, 10)}-${vatCommit}`;
    const runDir = safePath.join(options.out, runDirName);
    // eslint-disable-next-line local/no-fs-mkdirSync, security/detect-non-literal-fs-filename -- composed under user-supplied --out
    mkdirSync(runDir, { recursive: true });

    const rows: PluginRow[] = [];
    for (const entry of seed.plugins) {
      logger.info(`[${entry.name}] auditing ${entry.source}`);
      const row = await auditOnePlugin(entry, {
        runDir,
        withReview: options.withReview === true,
        debug: options.debug === true,
      });
      rows.push(row);
      logger.info(`[${entry.name}] audit=${row.audit.status} review=${row.review.status}`);
    }

    const report: RunReport = {
      schema_version: 1,
      generated_at: generatedAt,
      vat_version: vatVersion,
      vat_commit: vatCommit,
      seed_file: seedPath,
      flags: {
        with_review: options.withReview === true,
        debug: options.debug === true,
      },
      plugins: rows,
    };

    await writeRunReport(report, options.out);

    logger.info(`Wrote run report to ${runDir}/summary.yaml`);
    logger.info(`  ${rows.length} plugins; durations recorded in summary.yaml`);
    logger.debug(`Total scan duration: ${Date.now() - startTime}ms`);
  } catch (err) {
    handleCommandError(err, logger, startTime, 'CorpusScan');
  }
}
