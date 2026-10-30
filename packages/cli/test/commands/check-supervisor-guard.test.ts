/**
 * The supervision guard exists for exactly the supervision's duration: the handlers it installs
 * on this process are gone once the supervision ends, however it ends — so a long-lived process
 * (`vat validate`, a test runner) does not accumulate them, and its own signal handling is back
 * the moment the child is.
 *
 * What the handlers DO is pinned through the real binary in
 * `checks-supervisor-orphan.system.test.ts`; here only their lifetime, on a stand-in child.
 */

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { __internal } from '../../src/commands/resources/check-supervisor.js';

const GUARDED_EVENTS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'exit'] as const;

/** A stand-in for a spawned child: the fields the guard reads, and `close`. */
class StandInChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);

  /** End as Node reports a child's end: the code or signal is set, then `close`. */
  end(ending: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.exitCode = ending.code;
    this.signalCode = ending.signal;
    this.emit('close', ending.code, ending.signal);
  }
}

/** This process's listener count for each guarded event. */
function listenerCounts(): Record<string, number> {
  return Object.fromEntries(GUARDED_EVENTS.map((event) => [event, process.listenerCount(event)]));
}

/** Install the guard on a stand-in child. */
function guard(child: StandInChild): () => void {
  // The guard reads only the stand-in's fields; it is not a real ChildProcess.
  return __internal.guardSupervision(child as unknown as Parameters<typeof __internal.guardSupervision>[0], '/nowhere/progress.jsonl');
}

describe('the supervision guard — its lifetime', () => {
  const releases: Array<() => void> = [];

  afterEach(() => {
    // A red case must not leave its handlers on the runner's process.
    for (const release of releases.splice(0)) release();
  });

  it('adds exactly one handler per guarded event while it supervises', () => {
    const baseline = listenerCounts();

    releases.push(guard(new StandInChild()));

    expect(listenerCounts()).toStrictEqual(Object.fromEntries(GUARDED_EVENTS.map((event) => [event, (baseline[event] ?? 0) + 1])));
  });

  it.each([
    ['a completed run (exit 0)', { code: 0, signal: null }],
    ['a failed run (exit 1)', { code: 1, signal: null }],
    ['a killed run (SIGKILL)', { code: null, signal: 'SIGKILL' as const }],
  ])('returns to baseline when %s ends the supervision', (_label, ending) => {
    const baseline = listenerCounts();
    const child = new StandInChild();
    const release = guard(child);

    child.end(ending);
    release();

    expect(listenerCounts()).toStrictEqual(baseline);
  });

  it('returns to baseline when the child never started', () => {
    const baseline = listenerCounts();
    const child = new StandInChild();
    child.pid = undefined;

    guard(child)();

    expect(listenerCounts()).toStrictEqual(baseline);
  });

  it('keeps only the exit guard past a run that settled with its child alive (a refused kill), until the child ends', () => {
    const baseline = listenerCounts();
    const child = new StandInChild();

    guard(child)();

    expect(listenerCounts()).toStrictEqual({ ...baseline, exit: (baseline['exit'] ?? 0) + 1 });
    child.end({ code: null, signal: 'SIGKILL' });
    expect(listenerCounts()).toStrictEqual(baseline);
  });
});
