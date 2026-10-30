/**
 * `no-raw-signal-listener` — a terminating-signal handler goes through `handleTerminatingSignals`,
 * never `process.on(<signal>)`. The VALID cases matter as much: a rule that fired on an ordinary
 * `process.on('exit')` would be disabled within a week.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-raw-signal-listener';
const LINTED = '/repo/packages/cli/src/commands/audit/git-url-clone.ts';
const HELPER = 'packages/utils/src/terminating-signals.ts';
const ALLOW_HELPER = [{ allow: [HELPER] }];

const CASES: RuleCases = {
  valid: [
    // Ordinary process events, named literally.
    { code: "process.on('exit', onExit);", filename: LINTED },
    { code: "process.once('uncaughtException', onThrow);", filename: LINTED },
    { code: "process.on('warning', onWarning);", filename: LINTED },
    { code: 'process.on(`message`, onMessage);', filename: LINTED },
    // Removing a listener is not installing one.
    { code: "process.off('SIGINT', handler);", filename: LINTED },
    { code: "process.removeListener('SIGTERM', handler);", filename: LINTED },
    // Not `process`.
    { code: "child.on('SIGINT', handler);", filename: LINTED },
    { code: "emitter.once(signal, handler);", filename: LINTED },
    // The helper itself, and only it, by repo-relative path.
    { code: 'for (const signal of TERMINATING_SIGNALS) process.on(signal, onSignal);', filename: `/repo/${HELPER}`, options: ALLOW_HELPER },
    { code: "process.on('SIGINT', onSignal);", filename: String.raw`C:\repo\packages\utils\src\terminating-signals.ts`, options: ALLOW_HELPER },
    // The way it is meant to be done.
    { code: 'handleTerminatingSignals({ cleanup, fallbackExitCode: ExitCode.ERROR });', filename: LINTED },
  ],
  invalid: [
    { code: "process.on('SIGINT', () => process.exit(ExitCode.OK));", filename: LINTED, errors: [{ messageId: 'signalListener', data: { method: 'on', event: 'SIGINT' } }] },
    { code: "process.once('SIGTERM', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "process.addListener('SIGHUP', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "process.prependListener('SIGBREAK', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "process.prependOnceListener('SIGQUIT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: 'process.on(`SIGINT`, handler);', filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: 'process.on(`SIG${name}`, handler);', filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    // A signal list spread into a loop — the shape the supervisor and the wrapper used.
    { code: 'for (const signal of TERMINATING_SIGNALS) process.on(signal, forward);', filename: LINTED, errors: [{ messageId: 'computedEvent' }] },
    { code: "for (const [sig] of SIGNAL_NUMBERS) process.on(sig, handler);", filename: LINTED, errors: [{ messageId: 'computedEvent' }] },
    { code: 'process.once(events.interrupt, handler);', filename: LINTED, errors: [{ messageId: 'computedEvent' }] },
    // The allow list names one file; a same-named file elsewhere is not it.
    { code: "process.on('SIGINT', onSignal);", filename: '/repo/packages/cli/src/terminating-signals.ts', options: ALLOW_HELPER, errors: [{ messageId: 'signalListener' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
