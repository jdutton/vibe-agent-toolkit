#!/usr/bin/env node
/**
 * compat-empirical — CLI entry point.
 *
 * Subcommands:
 *   predict  Run static prediction against the corpus manifest.
 *   run      Install + invoke each skill in each runtime.
 *   judge    Run the LLM judge over captured observations.
 *   report   Render the markdown matrix from predictions + observations + judgments.
 *   all      Sequence: predict -> run -> judge -> report.
 *
 * Reads the corpus from --manifest, writes outputs under --out. Every
 * artifact path is harness-controlled; the readline gates in cowork/chat
 * drivers handle human-in-the-loop steps.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- CLI option paths are user-controlled */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { PROJECT_ROOT, colors, getDirname, log } from '../common.js';

import { fetchSource } from './corpus/fetch-sources.js';
import {
  indexPromptsById,
  loadManifest,
  loadTriggerPrompts,
  validateEntryPromptKinds,
} from './corpus/load-manifest.js';
import {
  judgeCompletion,
  readCurrentSystemPrompt,
  reJudgeCompletion,
} from './judge/llm-judge.js';
import { joinMatrix } from './report/join.js';
import { renderReport } from './report/render-md.js';
import { runMatrix } from './run/run-matrix.js';
import { ClaudeChatDriver } from './runtimes/claude-chat.js';
import { captureClaudeCodeVersion, ClaudeCodeDriver } from './runtimes/claude-code.js';
import { ClaudeCoworkDriver } from './runtimes/claude-cowork.js';
import type { RuntimeDriver } from './runtimes/driver.js';
import { resolveOAuthToken } from './runtimes/shared/claude-cli.js';
import { predictForSkill } from './static-predict/predict.js';
import {
  JudgeCallArtifactSchema,
  JudgeResultSchema,
  RunMetadataSchema,
  RuntimeObservationSchema,
  StaticPredictionSchema,
  TargetSchema,
  type CorpusEntry,
  type CorpusManifest,
  type JudgeResult,
  type RunMetadata,
  type RuntimeObservation,
  type StaticPrediction,
  type Target,
  type TriggerPrompt,
} from './types.js';

const DEFAULT_TARGETS_CSV = 'claude-code,claude-cowork,claude-chat';
const OBSERVATIONS_JSON_FILE = 'observations.json';

interface CommonOpts {
  manifest: string;
  prompts: string;
  out: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSyncReal(dir, { recursive: true });
}

function sha256OfFile(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function readVatVersion(): string {
  const pkgPath = safePath.join(PROJECT_ROOT, 'packages', 'cli', 'package.json');
  const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  return json.version ?? 'unknown';
}

function judgePromptShaFor(): string {
  const promptPath = safePath.join(getDirname(import.meta.url), 'judge', 'prompts', 'judge-system.md');
  if (!existsSync(promptPath)) return 'unknown';
  return sha256OfFile(promptPath);
}

function buildDriverFor(target: Target): RuntimeDriver {
  switch (target) {
    case 'claude-code': return new ClaudeCodeDriver();
    case 'claude-cowork': return new ClaudeCoworkDriver();
    case 'claude-chat': return new ClaudeChatDriver();
  }
}

function loadCorpus(opts: CommonOpts): {
  manifest: CorpusManifest;
  entries: CorpusEntry[];
  promptById: Map<string, TriggerPrompt>;
  outDir: string;
  transcriptsDir: string;
} {
  const manifest = loadManifest(opts.manifest);
  const prompts = loadTriggerPrompts(opts.prompts);
  const promptById = indexPromptsById(prompts);
  // Cross-file invariant: every entry has >=1 positive AND >=1 negative prompt.
  // Throw here so an invalid manifest fails before any driver setup happens.
  validateEntryPromptKinds(manifest, promptById);
  const outDir = toForwardSlash(opts.out);
  ensureDir(outDir);
  const transcriptsDir = safePath.join(outDir, 'transcripts');
  ensureDir(transcriptsDir);
  return { manifest, entries: manifest.entries, promptById, outDir, transcriptsDir };
}

async function commandPredict(opts: CommonOpts): Promise<void> {
  const { entries, outDir } = loadCorpus(opts);
  const vatVersion = readVatVersion();
  const predictions: StaticPrediction[] = [];

  for (const entry of entries) {
    log(`[predict] ${entry.id}`, 'cyan');
    const staged = fetchSource(entry, PROJECT_ROOT);
    const declared = entry.declaredTargets;
    const prediction = await predictForSkill({
      skillId: entry.id,
      skillPath: staged.skillPath,
      ...(declared === undefined ? {} : { declaredTargets: declared }),
      vatVersion,
    });
    predictions.push(prediction);
  }

  const outPath = safePath.join(outDir, 'predictions.json');
  writeFileSync(outPath, JSON.stringify(predictions, null, 2), 'utf8');
  log(`[predict] wrote ${predictions.length} predictions -> ${outPath}`, 'green');
}

interface RunOptions extends CommonOpts {
  targets?: string;
}

function safeWriteObservations(path: string, observations: RuntimeObservation[]): void {
  try {
    writeFileSync(path, JSON.stringify(observations, null, 2), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[run] failed to write observations.json: ${msg}`, 'red');
  }
}

async function teardownAllDrivers(drivers: Map<Target, RuntimeDriver>): Promise<void> {
  // Per-driver try/catch so one failing teardown doesn't strand other drivers'
  // resources, and so the catch can't replace a primary error from the loop.
  for (const d of drivers.values()) {
    try {
      await d.teardown();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[run] teardown failed for ${d.target}: ${msg}`, 'red');
    }
  }
}

async function commandRun(opts: RunOptions): Promise<void> {
  await resolveOAuthToken(); // prompt the operator for their own token once, up front (or read env), before any spawn
  const { entries, promptById, outDir, transcriptsDir, manifest } = loadCorpus(opts);
  const targetsCsv = opts.targets ?? DEFAULT_TARGETS_CSV;
  // Validate each token via TargetSchema so a typo like `claude-cod` produces
  // a clean Zod error here rather than a TypeError on `d.setup()` later.
  const targets = targetsCsv.split(',').map((s) => TargetSchema.parse(s.trim()));

  const observationsDir = safePath.join(outDir, 'observations');
  ensureDir(observationsDir);

  const drivers = new Map<Target, RuntimeDriver>();
  for (const t of targets) drivers.set(t, buildDriverFor(t));

  let observations: RuntimeObservation[] = [];
  const observationsPath = safePath.join(outDir, OBSERVATIONS_JSON_FILE);

  try {
    // Setup inside the try block: if a later driver's setup throws, the
    // finally still tears down the earlier drivers that did set up.
    for (const d of drivers.values()) await d.setup();

    observations = await runMatrix({
      entries,
      promptById,
      drivers,
      repeatN: manifest.repeatN,
      transcriptsDir,
      observationsDir,
      stageFn: (entry) => fetchSource(entry, PROJECT_ROOT),
      log,
    });
  } finally {
    // Persist whatever was collected even if the loop threw, so a mid-corpus
    // failure doesn't lose every cell completed before the crash. Helpers
    // swallow secondary failures so they don't replace the primary error in
    // JS's finally semantics (a throw here would mask the loop's exception).
    safeWriteObservations(observationsPath, observations);
    await teardownAllDrivers(drivers);
  }

  log(`[run] wrote ${observations.length} observations -> ${observationsPath}`, 'green');
}

/**
 * Skip observations where calling the judge produces no signal: the cell was
 * intentionally bypassed, the runtime timed out, or the transcript is empty
 * (install-failure stubs hit this branch). Empty transcripts force the model
 * to confabulate a verdict, contaminating the matrix.
 */
function shouldJudge(obs: RuntimeObservation): boolean {
  if (obs.exitStatus === 'skipped' || obs.exitStatus === 'timeout') return false;
  if (obs.outputText.trim().length === 0 && obs.toolUseEvents.length === 0) return false;
  return true;
}

async function commandJudge(opts: CommonOpts): Promise<void> {
  await resolveOAuthToken(); // prompt the operator for their own token once, up front (or read env), before any spawn
  const { entries, promptById, outDir } = loadCorpus(opts);
  const observationsPath = safePath.join(outDir, OBSERVATIONS_JSON_FILE);
  if (!existsSync(observationsPath)) {
    throw new Error(`observations.json not found at ${observationsPath}; run \`run\` first.`);
  }
  const observations = JSON.parse(readFileSync(observationsPath, 'utf8')) as RuntimeObservation[];

  const judgments: JudgeResult[] = [];
  // Persisting judge calls is what makes the `re-judge` subcommand cheap:
  // an A/B prompt iteration becomes a 30-second read-from-disk loop instead
  // of a re-spend of all the operator hours that went into the run phase.
  const callsDir = safePath.join(outDir, 'judge-calls');
  const judgePromptSha = judgePromptShaFor();

  for (const obs of observations) {
    const entry = entries.find((e) => e.id === obs.skillId);
    if (!entry) continue;
    // Route by the observation's own promptId — the run loop stamps every
    // observation with the trigger it was produced under, so the judge sees
    // the exact prompt the runtime saw (no guessing from entry.triggerPromptRefs).
    const trigger = promptById.get(obs.promptId);
    if (!trigger) {
      log(`[judge]   skip ${obs.skillId}/${obs.target}: missing prompt ${obs.promptId}`, 'yellow');
      continue;
    }
    if (!shouldJudge(obs)) continue;
    log(`[judge] ${obs.skillId} / ${obs.target}`, 'cyan');
    try {
      const judgment = await judgeCompletion({
        triggerPrompt: trigger.prompt,
        expected: trigger.expectedBehavior,
        observation: obs,
        callsDir,
        judgePromptSha,
      });
      judgments.push(JudgeResultSchema.parse(judgment));
    } catch (err) {
      log(`[judge]   error: ${err instanceof Error ? err.message : String(err)}`, 'red');
    }
  }

  writeFileSync(safePath.join(outDir, 'judgments.json'), JSON.stringify(judgments, null, 2), 'utf8');
  log(`[judge] wrote ${judgments.length} judgments (calls persisted to ${callsDir})`, 'green');
}

async function commandReport(opts: CommonOpts): Promise<void> {
  const { entries, promptById, outDir } = loadCorpus(opts);
  const predictions = JSON.parse(readFileSync(safePath.join(outDir, 'predictions.json'), 'utf8')) as StaticPrediction[];
  const observations = JSON.parse(readFileSync(safePath.join(outDir, OBSERVATIONS_JSON_FILE), 'utf8')) as RuntimeObservation[];
  const judgmentsPath = safePath.join(outDir, 'judgments.json');
  const judgments = existsSync(judgmentsPath)
    ? (JSON.parse(readFileSync(judgmentsPath, 'utf8')) as JudgeResult[])
    : [];

  const bucketBySkillId = new Map(entries.map((e) => [e.id, e.bucket]));
  const rows = joinMatrix({
    predictions: predictions.map((p) => StaticPredictionSchema.parse(p)),
    observations: observations.map((o) => RuntimeObservationSchema.parse(o)),
    judgments: judgments.map((j) => JudgeResultSchema.parse(j)),
    bucketBySkillId,
    promptById,
  });

  writeFileSync(safePath.join(outDir, 'matrix.json'), JSON.stringify(rows, null, 2), 'utf8');

  const runtimesCovered = [...new Set(observations.map((o) => o.target))] as Target[];
  // Capture optional version strings once so the truthy-check and the field
  // value can't race against each other (a transient spawn failure between
  // calls would otherwise produce `{ claudeCodeVersion: undefined }`, which
  // exactOptionalPropertyTypes treats as distinct from omitted).
  const claudeCodeVersion = captureClaudeCodeVersion();
  const bunVersion = process.versions['bun'];
  const meta: RunMetadata = RunMetadataSchema.parse({
    runId: randomUUID(),
    runDate: new Date().toISOString(),
    vatVersion: readVatVersion(),
    nodeVersion: process.version,
    judgeModel: judgments[0]?.judgeModel ?? 'claude-sonnet-4-6',
    authMode: 'subscription',
    judgePromptSha: judgePromptShaFor(),
    triggerPromptsSha: sha256OfFile(opts.prompts),
    manifestSha: sha256OfFile(opts.manifest),
    runtimesCovered,
    totalEntries: entries.length,
    ...(claudeCodeVersion ? { claudeCodeVersion } : {}),
    ...(bunVersion ? { bunVersion } : {}),
  });

  writeFileSync(safePath.join(outDir, 'run-metadata.json'), JSON.stringify(meta, null, 2), 'utf8');

  const markdown = renderReport({ rows, meta });
  const reportPath = safePath.join(outDir, 'report.md');
  writeFileSync(reportPath, markdown, 'utf8');
  log(`[report] wrote ${reportPath}`, 'green');
}

async function commandAll(opts: RunOptions): Promise<void> {
  await commandPredict(opts);
  await commandRun(opts);
  await commandJudge(opts);
  await commandReport(opts);
}

interface ReJudgeOpts {
  run: string;
  judgeModel?: string;
  usePersistedSystemPrompt?: boolean;
}

/**
 * Re-execute every persisted judge call in `${opts.run}/judge-calls/` against
 * an optionally different model, optionally swapping in the current
 * on-disk judge-system.md (default) or the persisted system prompt
 * (`--use-persisted-system-prompt`). Writes `judgments-rerun.json` alongside
 * the original `judgments.json` so the two are diffable.
 *
 * No corpus or observations are re-loaded — the persisted artifact contains
 * the verbatim user message that was sent, so re-judge is a closed-form
 * replay against the model API only.
 */
async function commandReJudge(opts: ReJudgeOpts): Promise<void> {
  await resolveOAuthToken(); // prompt the operator for their own token once, up front (or read env), before any spawn
  const outDir = toForwardSlash(opts.run);
  const callsDir = safePath.join(outDir, 'judge-calls');
  if (!existsSync(callsDir)) {
    throw new Error(`no judge-calls directory at ${callsDir} — run \`judge\` first.`);
  }
  // Lazy import to keep glob/fs ergonomics co-located with the subcommand.
  const { readdirSync } = await import('node:fs');
  const callFiles = readdirSync(callsDir).filter((f) => f.endsWith('.json'));
  if (callFiles.length === 0) {
    throw new Error(`no *.json artifacts under ${callsDir}`);
  }

  const systemPromptOverride = opts.usePersistedSystemPrompt ? undefined : readCurrentSystemPrompt();
  const rerun: JudgeResult[] = [];

  // Stable iteration order so a re-judge log line stays diffable across runs.
  const sortedFiles = [...callFiles].sort((a, b) => a.localeCompare(b));
  for (const file of sortedFiles) {
    const path = safePath.join(callsDir, file);
    const artifact = JudgeCallArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    log(`[re-judge] ${artifact.skillId} / ${artifact.target} (${file})`, 'cyan');
    try {
      const result = await reJudgeCompletion({
        artifact,
        ...(opts.judgeModel === undefined ? {} : { model: opts.judgeModel }),
        ...(systemPromptOverride === undefined ? {} : { systemPromptOverride }),
      });
      rerun.push(result);
    } catch (err) {
      log(`[re-judge]   error: ${err instanceof Error ? err.message : String(err)}`, 'red');
    }
  }

  const rerunPath = safePath.join(outDir, 'judgments-rerun.json');
  writeFileSync(rerunPath, JSON.stringify(rerun, null, 2), 'utf8');
  log(`[re-judge] wrote ${rerun.length} re-judgments -> ${rerunPath}`, 'green');
}

function main(): void {
  const program = new Command();

  program
    .name('compat-empirical')
    .description('Empirical compatibility harness — runs VAT static predictions against real runtime behavior')
    .showHelpAfterError();

  const commonOptions = <T extends Command>(cmd: T): T => {
    cmd
      .requiredOption('-m, --manifest <path>', 'corpus manifest YAML')
      .requiredOption('-p, --prompts <path>', 'trigger prompts YAML')
      .requiredOption('-o, --out <dir>', 'output directory for this run');
    return cmd;
  };

  commonOptions(program.command('predict'))
    .description('Run static predictions across the corpus')
    .action(async (opts: CommonOpts) => {
      await commandPredict(opts);
    });

  commonOptions(program.command('run'))
    .description('Install + invoke each skill in each runtime')
    .option('-t, --targets <csv>', 'comma-separated targets', DEFAULT_TARGETS_CSV)
    .action(async (opts: RunOptions) => {
      await commandRun(opts);
    });

  commonOptions(program.command('judge'))
    .description('Run the LLM judge over captured observations')
    .action(async (opts: CommonOpts) => {
      await commandJudge(opts);
    });

  commonOptions(program.command('report'))
    .description('Render the matrix and markdown report')
    .action(async (opts: CommonOpts) => {
      await commandReport(opts);
    });

  commonOptions(program.command('all'))
    .description('Sequence: predict -> run -> judge -> report')
    .option('-t, --targets <csv>', 'comma-separated targets', DEFAULT_TARGETS_CSV)
    .action(async (opts: RunOptions) => {
      await commandAll(opts);
    });

  program.command('re-judge')
    .description('Re-execute persisted judge calls against an optionally different model / system prompt')
    .requiredOption('-r, --run <dir>', 'run directory containing judge-calls/')
    .option('--judge-model <model>', 'model to re-judge against (defaults to each artifact\'s judgeModel)')
    .option('--use-persisted-system-prompt', 'use the artifact\'s persisted system prompt (default: use the current judge-system.md on disk)', false)
    .action(async (opts: ReJudgeOpts) => {
      await commandReJudge(opts);
    });

  program.parseAsync(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${colors.red}error: ${msg}${colors.reset}`);
    if (process.env['VAT_EMPIRICAL_TRACE']) {
      console.error(err);
    }
    process.exit(1);
  });
}

main();
