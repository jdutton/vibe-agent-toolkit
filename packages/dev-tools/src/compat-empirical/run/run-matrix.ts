/**
 * Pure-ish iteration of the (entry × prompt × attempt × target) matrix.
 *
 * Extracted from index.ts so the loop is unit-testable without spinning up
 * real drivers. The loop owns:
 *   - per-attempt invocation against the driver
 *   - manual-driver short-circuit (N=1 regardless of requested repeatN)
 *   - install-failure short-circuit (attempt 0 install fail fills the cell's
 *     remaining attempts as install-failed observations)
 *   - per-cell warning log when N was clamped for a manual/scripted-assisted
 *     driver (once per cell so the asymmetry is visible in the run log)
 *
 * Per-attempt state independence (e.g. claude-code's temp profile recreation)
 * is the driver's responsibility — the loop just calls invoke() N times and
 * trusts the driver to give each attempt a clean slate.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- observations dir is harness-controlled */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { Color } from '../../common.js';
import type { StagedSkill } from '../corpus/fetch-sources.js';
import type { RuntimeDriver } from '../runtimes/driver.js';
import {
  RuntimeObservationSchema,
  type CorpusEntry,
  type DriverMode,
  type RuntimeObservation,
  type Target,
  type TriggerPrompt,
} from '../types.js';

type StageFn = (entry: CorpusEntry) => StagedSkill;
type LogFn = (msg: string, color?: Color) => void;

export interface RunMatrixOptions {
  entries: readonly CorpusEntry[];
  promptById: ReadonlyMap<string, TriggerPrompt>;
  drivers: ReadonlyMap<Target, RuntimeDriver>;
  repeatN: number;
  transcriptsDir: string;
  observationsDir?: string;
  stageFn: StageFn;
  log?: LogFn;
}

interface InstallFailedArgs {
  skillId: string;
  promptId: string;
  attemptIdx: number;
  target: Target;
  driverMode: DriverMode;
  installNotes: string;
}

function effectiveN(driver: RuntimeDriver, requested: number): number {
  return driver.driverMode === 'scripted' ? requested : 1;
}

function makeInstallFailedObservation(args: InstallFailedArgs): RuntimeObservation {
  return RuntimeObservationSchema.parse({
    skillId: args.skillId,
    target: args.target,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    exitStatus: 'error',
    invocationDetected: false,
    outputText: '',
    toolUseEvents: [],
    errors: [`install failed: ${args.installNotes}`],
    installResult: { ok: false, notes: args.installNotes },
    transcriptPath: '',
    driverMode: args.driverMode,
    promptId: args.promptId,
    attemptIdx: args.attemptIdx,
  });
}

function persistObservation(
  observation: RuntimeObservation,
  observationsDir: string | undefined,
  entryId: string,
  promptId: string,
  target: Target,
  attemptIdx: number,
): void {
  if (!observationsDir) return;
  writeFileSync(
    safePath.join(observationsDir, `${entryId}-${promptId}-${target}-${attemptIdx}.json`),
    JSON.stringify(observation, null, 2),
    'utf8',
  );
}

interface CellContext {
  entry: CorpusEntry;
  trigger: TriggerPrompt;
  target: Target;
  driver: RuntimeDriver;
  staged: StagedSkill;
  n: number;
  transcriptsDir: string;
  observationsDir: string | undefined;
  log: LogFn;
}

async function runAttempt(
  ctx: CellContext,
  attemptIdx: number,
  installFailedNotes: string | undefined,
): Promise<{ observation: RuntimeObservation; nextInstallFailedNotes: string | undefined }> {
  if (installFailedNotes !== undefined) {
    const obs = makeInstallFailedObservation({
      skillId: ctx.entry.id,
      promptId: ctx.trigger.id,
      attemptIdx,
      target: ctx.target,
      driverMode: ctx.driver.driverMode,
      installNotes: installFailedNotes,
    });
    persistObservation(obs, ctx.observationsDir, ctx.entry.id, ctx.trigger.id, ctx.target, attemptIdx);
    return { observation: obs, nextInstallFailedNotes: installFailedNotes };
  }

  const installResult = await ctx.driver.install(ctx.staged);
  if (!installResult.ok) {
    ctx.log(`[run]   install failed: ${installResult.notes}`, 'red');
    const obs = makeInstallFailedObservation({
      skillId: ctx.entry.id,
      promptId: ctx.trigger.id,
      attemptIdx,
      target: ctx.target,
      driverMode: ctx.driver.driverMode,
      installNotes: installResult.notes,
    });
    persistObservation(obs, ctx.observationsDir, ctx.entry.id, ctx.trigger.id, ctx.target, attemptIdx);
    return { observation: obs, nextInstallFailedNotes: installResult.notes };
  }

  const rawObs = await ctx.driver.invoke({
    skillId: ctx.entry.id,
    promptId: ctx.trigger.id,
    attemptIdx,
    triggerPrompt: ctx.trigger.prompt,
    expected: ctx.trigger.expectedBehavior,
    transcriptDir: ctx.transcriptsDir,
    skill: ctx.staged,
  });
  const parsed = RuntimeObservationSchema.parse({
    ...rawObs,
    promptId: ctx.trigger.id,
    attemptIdx,
  });
  persistObservation(parsed, ctx.observationsDir, ctx.entry.id, ctx.trigger.id, ctx.target, attemptIdx);
  return { observation: parsed, nextInstallFailedNotes: undefined };
}

async function runCell(ctx: CellContext): Promise<RuntimeObservation[]> {
  const results: RuntimeObservation[] = [];
  let installFailedNotes: string | undefined;
  for (let attemptIdx = 0; attemptIdx < ctx.n; attemptIdx++) {
    ctx.log(
      `[run] ${ctx.entry.id}/${ctx.trigger.id} -> ${ctx.target} (attempt ${attemptIdx + 1}/${ctx.n})`,
      'cyan',
    );
    const outcome = await runAttempt(ctx, attemptIdx, installFailedNotes);
    results.push(outcome.observation);
    installFailedNotes = outcome.nextInstallFailedNotes;
  }
  return results;
}

export async function runMatrix(opts: RunMatrixOptions): Promise<RuntimeObservation[]> {
  const log = opts.log ?? ((): void => undefined);
  const observations: RuntimeObservation[] = [];

  for (const entry of opts.entries) {
    const staged = opts.stageFn(entry);
    for (const promptRef of entry.triggerPromptRefs) {
      const trigger = opts.promptById.get(promptRef);
      if (!trigger) {
        log(`[run] ${entry.id}: missing trigger prompt ${promptRef}; skipping`, 'yellow');
        continue;
      }
      for (const [target, driver] of opts.drivers) {
        const n = effectiveN(driver, opts.repeatN);
        if (n !== opts.repeatN) {
          // Disclose the clamp once per cell so the run log makes the
          // manual-driver N=1 asymmetry visible to operators.
          log(
            `[run]   ${entry.id}/${trigger.id} -> ${target}: ${driver.driverMode} driver clamps repeatN ${opts.repeatN} -> 1`,
            'yellow',
          );
        }
        const cellResults = await runCell({
          entry,
          trigger,
          target,
          driver,
          staged,
          n,
          transcriptsDir: opts.transcriptsDir,
          observationsDir: opts.observationsDir,
          log,
        });
        observations.push(...cellResults);
      }
    }
  }

  return observations;
}
