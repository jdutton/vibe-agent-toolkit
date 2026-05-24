/**
 * Shared scaffolding for runtimes that have no API path (claude-chat) or
 * pending investigation (claude-cowork). Both prepare a bundle directory
 * containing the staged skill, print install + paste instructions, and
 * gate on a human pasting the runtime's response back through a readline.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- bundle path is harness-controlled */

import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { promptForManualOutcome } from '../../cli/prompt-user.js';
import type { StagedSkill } from '../../corpus/fetch-sources.js';
import type {
  DriverMode,
  RuntimeObservation,
  Target,
} from '../../types.js';
import type { InvokeOpts, RuntimeDriver } from '../driver.js';

import { detectInvocationFromTranscript } from './transcript.js';

export interface ManualDriverConfig {
  target: Target;
  driverMode: Extract<DriverMode, 'manual' | 'scripted-assisted'>;
  /** prefix for the tmpdir created during setup() */
  tmpdirPrefix: string;
  /** instruction line printed above the bundle path */
  instructionText: string;
}

export class ManualDriverBase implements RuntimeDriver {
  readonly target: Target;
  readonly driverMode: ManualDriverConfig['driverMode'];
  private readonly tmpdirPrefix: string;
  private readonly instructionText: string;

  private bundleRoot: string | undefined;
  private currentBundleDir: string | undefined;

  constructor(config: ManualDriverConfig) {
    this.target = config.target;
    this.driverMode = config.driverMode;
    this.tmpdirPrefix = config.tmpdirPrefix;
    this.instructionText = config.instructionText;
  }

  async setup(): Promise<void> {
    this.bundleRoot = toForwardSlash(safePath.join(normalizedTmpdir(), `${this.tmpdirPrefix}-${process.pid}`));
    mkdirSyncReal(this.bundleRoot, { recursive: true });
  }

  async install(skill: StagedSkill): Promise<{ ok: boolean; notes: string }> {
    if (!this.bundleRoot) throw new Error(`${this.constructor.name}.install called before setup`);
    const dir = safePath.join(this.bundleRoot, skill.entryId);
    if (existsSync(dir)) {
      this.currentBundleDir = dir;
      return { ok: true, notes: `bundle reused at ${dir}` };
    }
    mkdirSyncReal(dir, { recursive: true });
    cpSync(skill.rootDir, dir, { recursive: true });
    this.currentBundleDir = dir;
    return { ok: true, notes: `bundle prepared at ${dir}` };
  }

  async invoke(opts: InvokeOpts): Promise<RuntimeObservation> {
    if (!this.bundleRoot) throw new Error(`${this.constructor.name}.invoke called before setup`);
    const startedAt = new Date().toISOString();
    const startedTs = Date.now();

    const bundleDir = this.currentBundleDir ?? this.bundleRoot;
    const transcriptPath = safePath.join(opts.transcriptDir, `${opts.skillId}-${this.target}.log`);

    const banner = [
      '',
      `─── [${this.target}] manual confirmation ────────────────────`,
      `skill:  ${opts.skillId}`,
      `bundle: ${bundleDir}`,
      `prompt: ${opts.triggerPrompt}`,
      '─────────────────────────────────────────────────────────────',
      this.instructionText,
    ].join('\n');

    const outcome = await promptForManualOutcome(banner);
    if (outcome === 'skip') {
      writeFileSync(transcriptPath, '<skipped by user>\n', 'utf8');
      return {
        skillId: opts.skillId,
        target: this.target,
        startedAt,
        durationMs: Date.now() - startedTs,
        exitStatus: 'skipped',
        invocationDetected: false,
        outputText: '',
        toolUseEvents: [],
        errors: [],
        installResult: { ok: true, notes: 'user-skipped before invoke' },
        transcriptPath,
        driverMode: this.driverMode,
        // TASK-2-WILL-REPLACE: promptId/attemptIdx flow in via InvokeOpts in Task 2;
        // here we emit placeholders so the run loop can overwrite them at the call site.
        promptId: '',
        attemptIdx: 0,
      };
    }

    writeFileSync(transcriptPath, `${outcome.outputText}\n`, 'utf8');

    // Use the same invocation heuristic as the scripted driver so manual and
    // scripted cells are commensurable in the matrix. Manual transcripts have
    // no tool_use events, so detection falls through to substring matching
    // against opts.expected.invocationSignals.
    const invocationDetected = detectInvocationFromTranscript(
      { text: outcome.outputText, toolUseEvents: [], errors: [], raw: [] },
      opts.expected.invocationSignals,
    );

    return {
      skillId: opts.skillId,
      target: this.target,
      startedAt,
      durationMs: Date.now() - startedTs,
      exitStatus: 'completed',
      invocationDetected,
      outputText: outcome.outputText,
      toolUseEvents: [],
      errors: [],
      installResult: { ok: true, notes: outcome.notes },
      transcriptPath,
      driverMode: this.driverMode,
      // TASK-2-WILL-REPLACE: promptId/attemptIdx flow in via InvokeOpts in Task 2;
      // here we emit placeholders so the run loop can overwrite them at the call site.
      promptId: '',
      attemptIdx: 0,
    };
  }

  async teardown(): Promise<void> {
    // Symmetric with ClaudeCodeDriver.teardown — without rmSync the tmpdir
    // accumulates one tree per run, and stale dirs from prior runs with the
    // same PID could short-circuit a future install() via the existsSync
    // reuse branch.
    if (this.bundleRoot && existsSync(this.bundleRoot)) {
      rmSync(this.bundleRoot, { recursive: true, force: true });
    }
    this.bundleRoot = undefined;
    this.currentBundleDir = undefined;
  }
}
