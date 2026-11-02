/**
 * The `memory` facet's spawner: a minimal, freshly started node process that
 * launches one measured repeat, so the repeat's peak cannot include the lab's.
 *
 * ## Why it exists
 *
 * On Linux a child's `maxRSS` is not its own from zero: `fork()` copies the
 * parent's address space, and the kernel carries the copy's resident high-water
 * mark into the child's peak across `exec`. A vat launched straight from the lab
 * reports at least the lab's own resident set — a vitest worker's, or a
 * `vat-lab` process holding parsed reports — and a small vat read as a large one.
 * Launched from here, the floor a measured process inherits is this process's
 * resident set: a small node's, the same on every repeat and every arm.
 *
 * The spawner writes its own peak too (through the RSS probe, which recognises
 * it by {@link SPAWNER_PID_ENV}), so a report carries the floor beside every
 * repeat instead of asserting it.
 *
 * ## The argument contract
 *
 * `node rss-spawner.js <direct|shell> <file> [args…]`. The lab has already
 * resolved the command and decided the shell mode (`harness/run.ts`), so a
 * `.cmd` shim on Windows is launched exactly as an unwrapped repeat would be;
 * in `shell` mode `<file>` is the whole command line and no arguments follow.
 *
 * It imports only the two narrow contracts it ends on — the exit codes and the
 * terminating-signal guard — so its floor stays small. A terminating signal sent
 * to the spawner (the lab's timeout) is passed on to the child and the spawner
 * dies of it once the child has ended; a child killed by a signal of its own
 * kills the spawner with the same one; any other exit status is passed through
 * unchanged. The lab reads the repeat exactly as it would read the child.
 */

import { spawn } from 'node:child_process';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { handleTerminatingSignals, reRaiseSignal } from '@vibe-agent-toolkit/utils/process';

/** Set to the spawner's own pid, so the probe can tell the spawner's exit from any other process's. */
const SPAWNER_PID_ENV = 'VAT_LAB_SPAWNER_PID';

const [mode, file, ...args] = process.argv.slice(2);
if ((mode !== 'direct' && mode !== 'shell') || file === undefined) {
  process.stderr.write('[vat-lab rss spawner] usage: rss-spawner <direct|shell> <file> [args…]\n');
  process.exit(ExitCode.ERROR);
}

process.env[SPAWNER_PID_ENV] = String(process.pid);
const env: NodeJS.ProcessEnv = { ...process.env };
delete env[SPAWNER_PID_ENV];

const child = spawn(file, args, { stdio: 'inherit', env, shell: mode === 'shell' });
const exited = new Promise<void>((resolve) => {
  child.once('exit', () => resolve());
  child.once('error', () => resolve());
});

const guard = handleTerminatingSignals({
  cleanup: (signal) => {
    child.kill(signal);
    return exited;
  },
  fallbackExitCode: ExitCode.ERROR,
});

child.on('error', (error) => {
  process.stderr.write(`[vat-lab rss spawner] could not start '${file}': ${error.message}\n`);
  guard.release();
  process.exitCode = ExitCode.ERROR;
});

child.on('exit', (code, signal) => {
  // A signal already ending the spawner decides how it ends; the guard waits for this exit.
  if (!guard.release()) return;
  if (signal !== null) reRaiseSignal(signal, ExitCode.ERROR);
  if (code !== null) process.exitCode = code;
});
