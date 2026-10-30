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
    // Removing a listener for an ordinary event.
    { code: "process.off('exit', handler);", filename: LINTED },
    { code: "process.removeListener('warning', handler);", filename: LINTED },
    { code: "process.removeAllListeners('exit');", filename: LINTED },
    // `node:events`' static forms on another emitter, or for an ordinary event.
    { code: "import { once } from 'node:events'; await once(child, 'SIGINT');", filename: LINTED },
    { code: "import { once } from 'node:events'; await once(process, 'exit');", filename: LINTED },
    // A shadowing local named `process` that is not the process.
    { code: "function f(process) { process.on('SIGINT', h); }", filename: LINTED },
    // A `require`-style import of another module.
    { code: "import path = require('node:path'); path.join(a, b);", filename: LINTED },
    // Another module's `on`.
    { code: "import { on } from 'node:events'; on(emitter, 'SIGINT');", filename: LINTED },
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
    // Removal by hand can strip a guard's listener.
    { code: "process.off('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalRemoval' }] },
    { code: "process.removeListener('SIGTERM', handler);", filename: LINTED, errors: [{ messageId: 'signalRemoval' }] },
    { code: "process.removeAllListeners('SIGTERM');", filename: LINTED, errors: [{ messageId: 'signalRemoval' }] },
    { code: 'process.removeAllListeners(signal);', filename: LINTED, errors: [{ messageId: 'signalRemoval' }] },
    { code: 'process.removeAllListeners();', filename: LINTED, errors: [{ messageId: 'signalRemoval' }] },
    // `node:events`' promise and iterator forms, with the process as the emitter.
    { code: "import { once } from 'node:events'; await once(process, 'SIGINT');", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import events from 'node:events'; await events.once(process, 'SIGTERM');", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import { on } from 'events'; for await (const _ of on(process, 'SIGHUP')) {}", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import { EventEmitter } from 'node:events'; EventEmitter.once(globalThis.process, signal);", filename: LINTED, errors: [{ messageId: 'computedEvent' }] },
    // A computed member.
    { code: "process['on']('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    // An alias, one or two deep.
    { code: "const p = process; p.on('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "const p = process; const q = p; q.once('SIGTERM', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    // Through the global object.
    { code: "globalThis.process.on('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "global['process'].addListener('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    // A `node:process` import: default, namespace, a named method.
    { code: "import proc from 'node:process'; proc.on('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import * as proc from 'node:process'; proc.prependListener('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import process from 'process'; process.prependOnceListener('SIGQUIT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import { on } from 'node:process'; on('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    { code: "import { once as listen } from 'node:process'; listen(signal, handler);", filename: LINTED, errors: [{ messageId: 'computedEvent' }] },
    { code: "import { off } from 'node:process'; off('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalRemoval' }] },
    { code: "import proc = require('node:process'); proc.on('SIGINT', handler);", filename: LINTED, errors: [{ messageId: 'signalListener' }] },
    // The allow list names one file; a same-named file elsewhere is not it.
    { code: "process.on('SIGINT', onSignal);", filename: '/repo/packages/cli/src/terminating-signals.ts', options: ALLOW_HELPER, errors: [{ messageId: 'signalListener' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
