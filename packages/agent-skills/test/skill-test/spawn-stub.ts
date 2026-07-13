/* eslint-disable security/detect-non-literal-fs-filename -- fragment paths are derived from our own temp grader dirs */
import { writeFileSync } from 'node:fs';

import { safePath, type SpawnHeadlessOptions, type spawnHeadlessClaude, type SpawnResult } from '@vibe-agent-toolkit/utils';
import { expect, vi } from 'vitest';

import { InternalHarnessError } from '../../src/skill-test/exit-codes.js';

/** A clean, successful spawn result (status 0, no watchdog kill). */
export const SPAWN_OK: SpawnResult = { status: 0, timedOut: false, stalled: false };
/** Watchdog wall-timeout kill. */
export const SPAWN_TIMED_OUT: SpawnResult = { status: -1, timedOut: true, stalled: false };
/** Watchdog stall kill. */
export const SPAWN_STALLED: SpawnResult = { status: -1, timedOut: false, stalled: true };

export interface SpawnStubBehavior {
  /** Lines emitted (each with a trailing newline) via `onStdout` before returning. */
  stdoutLines?: string[];
  /** Side-effect hook run after stdout, before resolving — e.g. write a fragment file. */
  beforeReturn?: (opts: SpawnHeadlessOptions) => void;
  /** When set, the spawn REJECTS with this error instead of resolving. */
  reject?: Error;
  /** The resolved result (default {@link SPAWN_OK}). */
  result?: SpawnResult;
}

export interface SpawnStub {
  spawn: (opts: SpawnHeadlessOptions) => Promise<SpawnResult>;
  /** Every `opts` the stub was invoked with, in call order. */
  calls: SpawnHeadlessOptions[];
}

/**
 * Shared spawn stub over `typeof spawnHeadlessClaude` for the executor and
 * grader per-eval spawn tests. Records each call's `opts` into `calls`,
 * optionally streams `stdoutLines` through `onStdout`, runs a `beforeReturn`
 * side-effect hook (e.g. writing a fragment to `fragmentOut`), and either
 * rejects (`reject`) or resolves (`result`). Extracted to kill the duplicated
 * inline stub factories the duplication gate flagged.
 */
export function makeSpawnStub(behavior: SpawnStubBehavior = {}): SpawnStub {
  const calls: SpawnHeadlessOptions[] = [];
  const spawn = vi.fn(async (opts: SpawnHeadlessOptions): Promise<SpawnResult> => {
    calls.push(opts);
    if (behavior.reject !== undefined) throw behavior.reject;
    for (const line of behavior.stdoutLines ?? []) {
      opts.onStdout?.(`${line}\n`);
    }
    behavior.beforeReturn?.(opts);
    return behavior.result ?? SPAWN_OK;
  });
  return { spawn, calls };
}

/**
 * Assert that `run()` rejects with {@link InternalHarnessError}. Shared by the
 * executor and grader tests' watchdog/spawn-reject cases (the identical
 * `.rejects.toBeInstanceOf(InternalHarnessError)` bodies the duplication gate
 * flagged).
 */
export async function expectInternalHarnessError(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(InternalHarnessError);
}

/** A tiny valid stream-json transcript line the fake executor streams to stdout. */
const FAKE_EXECUTOR_LINE =
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });

export interface HarnessFakeSpawnConfig {
  /** Executor spawn exit status (default 0). A non-zero status is a CLEAN failure. */
  executorStatus?: number;
  /** Whether every grader fragment marks its expectation passed (default true). */
  graderPassed?: boolean;
  /**
   * Per-eval override for whether the grader marks the expectation passed, keyed
   * by eval id. When it returns a boolean that wins; `undefined` falls back to
   * {@link graderPassed}. Lets a tiered test fail ONE tier's eval while the
   * others pass (issue #145 Phase G fail-fast gating).
   */
  graderPassedFor?: (evalId: string) => boolean | undefined;
  /** When true, the grader writes a WRONG runNonce (simulates a forged fragment). */
  forgeNonce?: boolean;
  /**
   * When the grader prompt carries a tool-verdict directive (the eval declared
   * `toolExpectations`), the fragment ALSO gets a `tool` body whose `passed` is
   * this value (default true). Set false to simulate a tool-expectation failure
   * while output expectations still pass — exercising the composite verdict.
   */
  graderToolPassed?: boolean;
}

export interface HarnessFakeSpawn {
  /** Drop-in for `spawnHeadlessClaude`, injected via `RunHarnessOptions.spawn`. */
  spawn: typeof spawnHeadlessClaude;
  /** Each grader spawn's sandboxDir (the vat-only grader dir), in call order. */
  graderSandboxDirs: string[];
  /** The integrity nonce parsed out of each grader prompt, in call order. */
  graderNonces: string[];
}

/**
 * A single fake `spawnHeadlessClaude` that plays BOTH roles of the per-eval
 * executor→grader pipeline (issue #145), so a test can drive the FULL
 * `runSkillTestHarness` with no real `claude`:
 *
 * - GRADER spawn (detected by the grader prompt's "fragment path" directive):
 *   parses the fragment path, eval id, and nonce out of the prompt and WRITES a
 *   valid nonce'd fragment JSON there (or a forged nonce when `forgeNonce`).
 * - EXECUTOR spawn (everything else): streams a tiny stream-json transcript and
 *   returns `executorStatus` (a non-zero status is a clean eval failure).
 *
 * Shared by the grading-nonce unit test and the harness integration test so the
 * fake lives once (duplication gate).
 */
export function makeHarnessFakeSpawn(cfg: HarnessFakeSpawnConfig = {}): HarnessFakeSpawn {
  const graderSandboxDirs: string[] = [];
  const graderNonces: string[] = [];
  const spawn = vi.fn(async (opts: SpawnHeadlessOptions): Promise<SpawnResult> => {
    const isGrader = opts.prompt.includes('fragment path');
    if (isGrader) {
      graderSandboxDirs.push(opts.sandboxDir);
      const fragmentPath = /fragment path (.+?),/.exec(opts.prompt)?.[1];
      const evalId = /Eval id: (\S+)/.exec(opts.prompt)?.[1] ?? 'unknown';
      const nonce = /EXACTLY: ([a-f0-9]+)/.exec(opts.prompt)?.[1] ?? '';
      graderNonces.push(nonce);
      // The grader prompt only carries this directive when the eval declared
      // toolExpectations (WITH arm) — mirror that by emitting a `tool` body then.
      const emitTool = opts.prompt.includes('"tool" object');
      const toolPassed = cfg.graderToolPassed ?? true;
      const passed = cfg.graderPassedFor?.(evalId) ?? cfg.graderPassed ?? true;
      if (fragmentPath !== undefined) {
        writeFileSync(
          fragmentPath,
          JSON.stringify({
            runNonce: cfg.forgeNonce === true ? 'f'.repeat(32) : nonce,
            evalId,
            expectations: [{ text: 'graded', passed }],
            ...(emitTool
              ? { tool: { mustRun: [{ name: 'dxa', ran: toolPassed }], passed: toolPassed } }
              : {}),
          }),
          'utf8',
        );
      }
      return SPAWN_OK;
    }
    opts.onStdout?.(`${FAKE_EXECUTOR_LINE}\n`);
    return { status: cfg.executorStatus ?? 0, timedOut: false, stalled: false };
  });
  return { spawn: spawn as unknown as typeof spawnHeadlessClaude, graderSandboxDirs, graderNonces };
}

/** True when `child` is contained within `root` (both compared as forward-slash paths). */
export function isUnderRoot(child: string, root: string): boolean {
  const c = safePath.resolve(child);
  const r = safePath.resolve(root);
  return c === r || c.startsWith(`${r}/`);
}
