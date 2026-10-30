/**
 * ESLint rule: no-raw-signal-listener
 *
 * Flags `process.on` / `process.once` / `process.addListener` / `process.prependListener` /
 * `process.prependOnceListener` for a SIGNAL — a string literal (or template) naming one, or any
 * event name that is not a literal at all (a loop variable over a signal list, a parameter).
 *
 * Why: a terminating-signal handler written by hand is the shape that leaked a clone and a lock.
 * It removed itself on the first signal and started an asynchronous cleanup, so the second — a
 * terminal Ctrl-C under a wrapper that forwards signals delivers two — met the default disposition
 * and killed the process half-way through the cleanup. `handleTerminatingSignals` (on
 * `@vibe-agent-toolkit/utils/process`) is the one installation: it swallows repeats until every
 * cleanup has settled, composes with every other live guard, and dies of the signal.
 *
 * An event name that is not a literal is flagged because a signal list spread into a loop is how
 * the second-commonest hand-written handler looks, and nothing at the call site says whether the
 * variable holds a signal. Name the event literally when it is not one.
 *
 * Option `allow: string[]` — repo-relative paths of the files permitted to listen directly (the one
 * file that implements the helper). Matched at a path-segment boundary via `exempt-path-matcher.cjs`.
 *
 * @example
 * // BAD
 * process.on('SIGINT', () => cleanup().then(() => process.exit(130)));
 * for (const signal of TERMINATING_SIGNALS) process.on(signal, onSignal);
 *
 * // GOOD
 * const guard = handleTerminatingSignals({ cleanup, fallbackExitCode: ExitCode.ERROR });
 * // ...
 * guard.release();
 */

'use strict';

const { createExemptPathMatcher } = require('./exempt-path-matcher.cjs');

const LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

/** Whether `callee` is `process.<a listener method>` (non-computed). */
function isProcessListenerCall(callee) {
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'process' &&
    callee.property.type === 'Identifier' &&
    LISTENER_METHODS.has(callee.property.name)
  );
}

/** The literal text of an event-name argument, or null when it is not literal. */
function literalEventName(arg) {
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  if (arg.type === 'TemplateLiteral') return arg.quasis[0].value.cooked.startsWith('SIG') ? 'SIG' : null;
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow process.on/once/addListener for a signal (or for any event not named literally) — ' +
        'install a terminating-signal handler through handleTerminatingSignals',
      category: 'Filesystem and process',
      bans: '`process.on(<signal>, …)` and `process.on(<non-literal>, …)`',
      useInstead: '`handleTerminatingSignals()`',
      subpath: '/process',
      // Not recommended: it names a helper an adopter may not use, and the one file allowed to
      // listen directly is a fact about each repo's layout (the `allow` option).
      recommended: false,
      recommendedSeverity: 'error',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      signalListener:
        'process.{{method}}(\'{{event}}\') installs a signal handler by hand. Use ' +
        'handleTerminatingSignals from @vibe-agent-toolkit/utils/process: it swallows a repeat ' +
        'while the cleanup runs, composes with every other guard, and dies of the signal.',
      computedEvent:
        'process.{{method}}(<non-literal>) may be a signal handler installed by hand. Name the ' +
        'event literally, or — for a signal — use handleTerminatingSignals from ' +
        '@vibe-agent-toolkit/utils/process.',
    },
  },

  create(context) {
    const allow = context.options?.[0]?.allow ?? [];
    const filename = context.filename ?? context.getFilename();
    if (createExemptPathMatcher(allow)(filename)) return {};

    return {
      CallExpression(node) {
        if (!isProcessListenerCall(node.callee) || node.arguments.length === 0) return;
        const method = node.callee.property.name;
        const event = literalEventName(node.arguments[0]);
        if (event === null) {
          context.report({ node, messageId: 'computedEvent', data: { method } });
        } else if (event.startsWith('SIG')) {
          context.report({ node, messageId: 'signalListener', data: { method, event } });
        }
      },
    };
  },
};
