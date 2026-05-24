/**
 * claude-code driver — fully scripted.
 *
 * Strategy: per-`invoke()` -> mkdtemp -> seed .claude/ skeleton -> drop the
 * staged skill into .claude/skills/<id>/ -> spawn
 * `claude -p "<prompt>" --output-format stream-json` with HOME pointing at the
 * temp profile -> parse the line-delimited JSON -> tear the profile down.
 *
 * Why per-`invoke()` (not per-`setup()`):
 *   Repeat-N relies on each attempt seeing a clean slate — any prior session
 *   cache, conversation history, or skill index lingering in the profile would
 *   contaminate subsequent attempts and mask real variance. Recreating the
 *   profile per invoke is the load-bearing isolation guarantee.
 *
 * Caveats:
 * - The harness records `invocationDetected` via a transcript heuristic
 *   (tool_use blocks present, or any invocationSignal substring in the
 *   assistant text). Both are explicitly approximate; the report names them
 *   in the methodology section.
 * - This driver assumes the `claude` CLI is on PATH. If not, `setup()` fails
 *   loudly rather than retrying.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- transcript path is harness-controlled */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { isToolAvailable, safePath, safeExecResult } from '@vibe-agent-toolkit/utils';

import type { StagedSkill } from '../corpus/fetch-sources.js';
import type {
  DriverMode,
  ExitStatus,
  RuntimeObservation,
  Target,
} from '../types.js';

import type { InvokeOpts, RuntimeDriver } from './driver.js';
import { createTempProfile, installSkillIntoProfile, teardownTempProfile } from './shared/temp-profile.js';
import { detectInvocationFromTranscript, parseStreamJsonTranscript } from './shared/transcript.js';

const DEFAULT_TIMEOUT_MS = 180_000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runClaudeCommand(
  args: string[],
  homeDir: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // Override every home-discovery env var the Claude CLI might consult so the
    // temp profile holds regardless of platform: HOME on POSIX, USERPROFILE on
    // Windows, XDG_CONFIG_HOME for tools that follow the XDG spec.
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: safePath.join(homeDir, '.config'),
    };
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- claude is the runtime we are explicitly testing; PATH is the standard location for the CLI
    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const handle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    child.on('close', (code) => {
      clearTimeout(handle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
        timedOut,
      });
    });

    child.on('error', () => {
      clearTimeout(handle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: -1,
        timedOut: false,
      });
    });
  });
}

function classifyExitStatus(result: SpawnResult): ExitStatus {
  if (result.timedOut) return 'timeout';
  if (result.exitCode === 0) return 'completed';
  return 'error';
}

export class ClaudeCodeDriver implements RuntimeDriver {
  readonly target: Target = 'claude-code';
  readonly driverMode: DriverMode = 'scripted';

  async setup(): Promise<void> {
    // Availability check only — profile lifecycle moved into `invoke()` so each
    // attempt sees a clean slate (no cached session/conversation state).
    if (!isToolAvailable('claude')) {
      throw new Error("claude CLI not found on PATH; claude-code driver cannot run.");
    }
  }

  async install(_skill: StagedSkill): Promise<{ ok: boolean; notes: string }> {
    // No-op: installation happens inside `invoke()` against a fresh per-attempt
    // profile. Kept on the interface for symmetry with manual drivers and so
    // the run loop's install-failure short-circuit semantics remain uniform.
    return { ok: true, notes: 'deferred to invoke()' };
  }

  async invoke(opts: InvokeOpts): Promise<RuntimeObservation> {
    if (!opts.skill) {
      throw new Error('ClaudeCodeDriver.invoke requires opts.skill (per-attempt profile install)');
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = new Date().toISOString();
    const startedTs = Date.now();

    // Fresh profile per attempt → no cache contamination across attempts.
    const profile = createTempProfile();
    try {
      installSkillIntoProfile(profile, opts.skill, opts.skill.entryId);

      const spawnResult = await runClaudeCommand(
        ['-p', opts.triggerPrompt, '--output-format', 'stream-json', '--verbose'],
        profile.homeDir,
        timeoutMs,
      );

      // promptId + attemptIdx in the path so concurrent / repeat attempts
      // don't overwrite each other's transcripts.
      const transcriptPath = safePath.join(
        opts.transcriptDir,
        `${opts.skillId}-${opts.promptId}-${opts.attemptIdx}-claude-code.log`,
      );
      writeFileSync(transcriptPath, spawnResult.stdout + '\n--- STDERR ---\n' + spawnResult.stderr, 'utf8');

      const parsed = parseStreamJsonTranscript(spawnResult.stdout);
      const invocationDetected = detectInvocationFromTranscript(parsed, opts.expected.invocationSignals);
      const exitStatus = classifyExitStatus(spawnResult);

      const errors = [...parsed.errors];
      if (spawnResult.stderr.trim().length > 0 && exitStatus === 'error') {
        errors.push(spawnResult.stderr.trim().slice(0, 1000));
      }

      return {
        skillId: opts.skillId,
        target: this.target,
        startedAt,
        durationMs: Date.now() - startedTs,
        exitStatus,
        invocationDetected,
        outputText: parsed.text,
        toolUseEvents: parsed.toolUseEvents,
        errors,
        installResult: { ok: true, notes: '' },
        transcriptPath,
        driverMode: 'scripted',
        promptId: opts.promptId,
        attemptIdx: opts.attemptIdx,
      };
    } finally {
      teardownTempProfile(profile);
    }
  }

  async teardown(): Promise<void> {
    // No-op: per-attempt profile teardown happens inside `invoke()`. Defining
    // an empty teardown keeps the RuntimeDriver contract honest and matches
    // the symmetry the run loop expects across drivers.
  }
}

export function captureClaudeCodeVersion(): string | undefined {
  const result = safeExecResult('claude', ['--version'], { encoding: 'utf8' });
  if (!result.success) return undefined;
  return result.stdout.toString().trim() || undefined;
}
