/**
 * The overlapped supervision scope: a checks child spawned before its turn, its stderr held in
 * `stderr.log`, and replayed, followed and finally read at the turn. Integration tier: a real child
 * (`test/helpers/overlap-child.mjs`, standing in for the vat binary), a real progress directory and
 * real fds.
 */
import type * as ChildProcessModule from 'node:child_process';
import type * as FsModule from 'node:fs';
import { existsSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import type * as UtilsModule from '@vibe-agent-toolkit/utils';
import { safePath } from '@vibe-agent-toolkit/utils';
import type * as ProcessModule from '@vibe-agent-toolkit/utils/process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __internal } from '../../src/commands/resources/check-supervisor.js';
import { buildCheckOutputData } from '../../src/commands/resources/check.js';
import { type OverlappedRun, startOverlappedSupervision } from '../../src/commands/resources/overlapped-supervision.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

const hooks = vi.hoisted(() => ({
  /** Set by a case to make the watchdog's stat of the progress log throw. */
  statThrows: undefined as Error | undefined,
  /** Called with the progress directory just before the guard or the scope removes it. */
  beforeDispose: undefined as ((dir: string) => void) | undefined,
  /** Every progress directory minted, in order. */
  minted: [] as string[],
  /** Every read fd opened on a `stderr.log`. */
  readFds: [] as number[],
  /** Every write fd opened on a `stderr.log`. */
  writeFds: [] as number[],
  /** How many of the next tree kills are refused, as Node reports a refused `child.kill` (EPERM). */
  killRefusals: 0,
  /** Every tree kill asked for, refused or not. */
  kills: 0,
  /** Every child spawned, in order. */
  children: [] as ChildProcessModule.ChildProcess[],
}));

vi.mock('../../src/utils/vat-bin-path.js', async () => {
  const { fileURLToPath } = await import('node:url');
  return { resolveVatBinPath: () => fileURLToPath(new URL('../helpers/overlap-child.mjs', import.meta.url)) };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      hooks.children.push(child);
      return child;
    },
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FsModule>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]).endsWith('stderr.log') && args[1] === 'r') hooks.readFds.push(fd);
      if (String(args[0]).endsWith('stderr.log') && args[1] === 'w') hooks.writeFds.push(fd);
      return fd;
    },
  };
});
vi.mock('@vibe-agent-toolkit/utils/process', async (original) => {
  const actual = await original<typeof ProcessModule>();
  return {
    ...actual,
    killProcessTree: (...args: Parameters<typeof actual.killProcessTree>) => {
      hooks.kills += 1;
      if (hooks.killRefusals > 0) {
        hooks.killRefusals -= 1;
        // What Node does when `subprocess.kill()` itself fails: an `error` event on the child.
        (args[0] as ChildProcessModule.ChildProcess).emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
        return;
      }
      actual.killProcessTree(...args);
    },
  };
});
vi.mock('@vibe-agent-toolkit/utils', async (original) => {
  const actual = await original<typeof UtilsModule>();
  return {
    ...actual,
    requireFollowedStatSync: (...args: Parameters<typeof actual.requireFollowedStatSync>) => {
      if (hooks.statThrows !== undefined) throw hooks.statThrows;
      return actual.requireFollowedStatSync(...args);
    },
    disposeTempDirSync: (dir: string) => {
      hooks.beforeDispose?.(dir);
      return actual.disposeTempDirSync(dir);
    },
    withTempDir: <T>(prefix: string, work: (dir: string) => Promise<T>) =>
      actual.withTempDir(prefix, (dir) => {
        hooks.minted.push(dir);
        return work(dir);
      }),
  };
});

/** A clean, whole check document: what a child that finished every check publishes, exit 0. */
const CLEAN_DOCUMENT = JSON.stringify(buildCheckOutputData({
  root: '/corpus',
  durationMs: 10,
  populated: { population: 'store', lensPopulation: 'none', populationMs: 5, lensMs: 0, lensesEvaluated: [], membersEnumerated: 1 },
  issues: [],
  // One check ran: a run with none is not a clean pass.
  costs: [{ name: 'no-markdown', durationMs: 1, rows: 0 }],
}));

/** A budget no case's silence reaches, so the watchdog never kills a healthy stand-in. */
const QUIET_BUDGET_MS = 60_000;

let work: string;
let documentFile: string;
let trigger: string;

/** Start an overlapped supervision of the stand-in child in `mode`. */
function start(
  mode: string,
  overrides: { budgetMs?: number; isArmed?: () => boolean; args?: () => readonly string[] } = {},
): Promise<OverlappedRun | 'disarmed'> {
  return startOverlappedSupervision({
    verb: 'resources check',
    args: overrides.args ?? (() => [mode, documentFile, trigger]),
    budgetMs: overrides.budgetMs ?? QUIET_BUDGET_MS,
    format: 'json',
    isArmed: overrides.isArmed ?? (() => true),
  });
}

/** Start, and fail the case unless a child was spawned. */
async function startArmed(mode: string, budgetMs = QUIET_BUDGET_MS): Promise<OverlappedRun> {
  const run = await start(mode, { budgetMs });
  if (run === 'disarmed') throw new Error('expected an armed run');
  return run;
}

/** A writer that collects the replayed bytes. */
function collector(): { write: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  return { write: (chunk) => chunks.push(Buffer.from(chunk)), text: () => Buffer.concat(chunks).toString('utf-8') };
}

/** The progress directory the only minted scope used. */
function mintedDir(): string {
  expect(hooks.minted).toHaveLength(1);
  return hooks.minted[0] ?? '';
}

/** Resolve once the held `stderr.log` contains `text`; fail the case after a bound. */
async function heldStderrContains(text: string): Promise<void> {
  const log = safePath.join(mintedDir(), 'stderr.log');
  for (let waited = 0; waited < 8000; waited += 10) {
    if (existsSync(log) && readFileSync(log, 'utf-8').includes(text)) return;
    await delay(10);
  }
  throw new Error(`the held stderr never contained ${JSON.stringify(text)}`);
}

beforeEach(() => {
  work = createTestTempDir('vat-overlap-test-');
  documentFile = safePath.join(work, 'document.json');
  trigger = safePath.join(work, 'trigger');
  writeFileSync(documentFile, CLEAN_DOCUMENT);
  hooks.statThrows = undefined;
  hooks.beforeDispose = undefined;
  hooks.minted = [];
  hooks.readFds = [];
  hooks.writeFds = [];
  hooks.killRefusals = 0;
  hooks.kills = 0;
  hooks.children = [];
});
afterEach(() => {
  // Releases a stand-in that a failed case left waiting.
  writeFileSync(trigger, '');
  writeFileSync(`${trigger}.exit`, '');
  cleanupTestTempDir(work);
});

describe('startOverlappedSupervision', () => {
  it('copies every byte of a child that ended before the turn, and removes the directory only after', async () => {
    const run = await startArmed('quick');
    await run.exited;
    const dir = mintedDir();
    expect(existsSync(safePath.join(dir, 'stderr.log'))).toBe(true);

    const replay = collector();
    const { value, leftover, stderrBytesAtTurn } = await run.atTurn(replay.write);

    expect(replay.text()).toBe('early stderr\n');
    // Every byte was already buffered when the turn started its copy.
    expect(stderrBytesAtTurn).toBe(Buffer.byteLength('early stderr\n'));
    expect(value).toMatchObject({ outcome: 'completed' });
    expect(leftover).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('follows the child from the turn: bytes written after it starts arrive before the child exits', async () => {
    const run = await startArmed('follow');
    let exited = false;
    const markExited = (): void => {
      exited = true;
    };
    run.exited.then(markExited, markExited);
    let exitedWhenLateArrived: boolean | undefined;
    const replay = collector();
    const ending = run.atTurn((chunk) => {
      replay.write(chunk);
      if (exitedWhenLateArrived === undefined && replay.text().includes('late stderr')) {
        exitedWhenLateArrived = exited;
        writeFileSync(`${trigger}.exit`, '');
      }
    });
    writeFileSync(trigger, '');

    const { value } = await ending;

    expect(replay.text()).toBe('early stderr\nlate stderr\n');
    expect(exitedWhenLateArrived).toBe(false);
    expect(value).toMatchObject({ outcome: 'completed' });
  });

  it('starts the stdout grace at the turn, not at an earlier exit', async () => {
    // The child exits at once; a grandchild holds its stdout and publishes the document only when
    // the trigger exists, which this case creates at the turn. A grace started at the exit would
    // have destroyed stdout long before, leaving a silent completion. The grace's timer is faked
    // from before the spawn, so a grace started at the exit fires when the clock is advanced past
    // it, with no real 2 s wait.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let run: OverlappedRun;
    try {
      run = await startArmed('grandchild');
      await run.exited;
      await vi.advanceTimersByTimeAsync(__internal.STDOUT_GRACE_AFTER_EXIT_MS + 100);
    } finally {
      vi.useRealTimers();
    }
    writeFileSync(trigger, '');

    const { value } = await run.atTurn(collector().write);

    // The whole ending in the message: an `abnormal` one says why (its kind and what was read).
    expect(value, JSON.stringify(value)).toMatchObject({ outcome: 'completed' });
  });

  it('records a supervision throw before the turn without an unhandled rejection, and rethrows it at the turn', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const refusal = new Error('stat refused');
      const run = await startArmed('hang', 500);
      // Throw only once the child's line is held: armed at the spawn, a slow runner's first
      // watchdog stat can kill the child before it writes anything, leaving nothing to replay.
      await heldStderrContains('early stderr\n');
      hooks.statThrows = refusal;
      await run.exited;
      // `exited` is the killed child's real exit, not the supervision's earlier rejection.
      expect(hasEnded(hooks.children[0])).toBe(true);
      await delay(20);

      expect(unhandled).not.toHaveBeenCalled();
      const replay = collector();
      await expect(run.atTurn(replay.write)).rejects.toBe(refusal);
      expect(replay.text()).toBe('early stderr\n');
      expect(existsSync(mintedDir())).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('ends the run incomplete when copying the held stderr fails at the turn, with the scope closed', async () => {
    const run = await startArmed('quick');
    await run.exited;
    const dir = mintedDir();
    expect(hooks.readFds).toHaveLength(1);
    const refusal = new Error('stderr write refused');

    await expect(run.atTurn(() => {
      throw refusal;
    })).rejects.toBe(refusal);

    expect(existsSync(dir)).toBe(false);
    expect(isOpen(hooks.readFds[0] ?? -1)).toBe(false);
  });

  it('abandons nothing once the turn has started: a later abandon neither rethrows the turn\'s error nor closes the scope again', async () => {
    const refusal = new Error('stat refused');
    hooks.statThrows = refusal;
    const run = await startArmed('hang', 500);
    await expect(run.atTurn(collector().write)).rejects.toBe(refusal);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(run.abandon()).resolves.toBeUndefined();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("closes the parent's stderr.log read fd before the guard's takedown removes the directory", async () => {
    const exitListeners = new Set(process.listeners('exit'));
    const run = await startArmed('hang');
    const takeDown = process.listeners('exit').find((listener) => !exitListeners.has(listener));
    expect(takeDown).toBeDefined();
    expect(hooks.readFds).toHaveLength(1);
    const readFd = hooks.readFds[0] ?? -1;
    let readFdOpenAtRemoval: boolean | undefined;
    hooks.beforeDispose = () => {
      readFdOpenAtRemoval ??= isOpen(readFd);
    };

    takeDown?.(0);

    expect(readFdOpenAtRemoval).toBe(false);
    expect(existsSync(mintedDir())).toBe(false);
    await run.abandon();
  });

  it('tears the scope down and spawns nothing when the armed check throws', async () => {
    const refusal = new Error('gate failed');

    await expectRefusedBeforeSpawn(refusal, {
      isArmed: () => {
        throw refusal;
      },
    });
  });

  it('tears the scope down and spawns nothing when disarmed after the mint', async () => {
    let dirAtCheck: boolean | undefined;
    const run = await start('quick', {
      isArmed: () => {
        dirAtCheck = existsSync(mintedDir());
        return false;
      },
    });

    expect(run).toBe('disarmed');
    expect(dirAtCheck).toBe(true);
    expect(existsSync(mintedDir())).toBe(false);
    expect(hooks.children).toHaveLength(0);
  });

  it('closes both fds and the scope, and spawns nothing, when building the child\'s arguments throws', async () => {
    const refusal = new Error('args failed');

    await expectRefusedBeforeSpawn(refusal, {
      args: () => {
        throw refusal;
      },
    });

    expect(hooks.readFds).toHaveLength(1);
    expect(hooks.writeFds).toHaveLength(1);
    expect(isOpen(hooks.readFds[0] ?? -1)).toBe(false);
    expect(isOpen(hooks.writeFds[0] ?? -1)).toBe(false);
  });

  it('kills an abandoned child through the watchdog: a refused kill is retried, never read as a spawn failure', async () => {
    const run = await startArmed('hang', 500);
    try {
      await heldStderrContains('early stderr\n');
      hooks.killRefusals = 1;

      await run.abandon();

      // Read as a spawn failure, the refusal settled the run with the child alive and stopped the
      // watchdog, so nothing ever retried the kill. Read as a refused kill, the watchdog retries it
      // at its next breach and the run settles at the child's exit. At least two: the budget clock
      // runs on, so a slow machine may breach again before the retried kill lands.
      expect(hooks.kills).toBeGreaterThanOrEqual(2);
      expect(hasEnded(hooks.children[0])).toBe(true);
      expect(existsSync(mintedDir())).toBe(false);
    } finally {
      hooks.children[0]?.kill('SIGKILL');
    }
  });

  it('kills a running child and closes the scope when abandoned', async () => {
    const run = await startArmed('hang');

    await run.abandon();

    await run.exited;
    expect(existsSync(mintedDir())).toBe(false);
  });
});

/**
 * Start with `overrides` and expect the start to reject with `refusal` before any spawn: the
 * directory removed, no child, and the guard's `exit` handler released.
 */
async function expectRefusedBeforeSpawn(refusal: Error, overrides: Parameters<typeof start>[1]): Promise<void> {
  const exitListeners = process.listeners('exit').length;
  await expect(start('quick', overrides)).rejects.toBe(refusal);
  expect(existsSync(mintedDir())).toBe(false);
  expect(hooks.children).toHaveLength(0);
  expect(process.listeners('exit')).toHaveLength(exitListeners);
}

/** Whether a spawned child has ended (an exit code or a terminating signal). */
function hasEnded(child: ChildProcessModule.ChildProcess | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

/** Whether `fd` is an open descriptor in this process. */
function isOpen(fd: number): boolean {
  try {
    fstatSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBADF') return false;
    throw error;
  }
}
