/**
 * ESLint rule: no-raw-signal-listener
 *
 * Flags every way of adding — or removing — a listener for a SIGNAL on the process by hand. The
 * event is a signal when it is a string literal (or template) naming one, or any event name that
 * is not a literal at all (a loop variable over a signal list, a parameter). Caught shapes:
 *
 * - `process.on` / `once` / `addListener` / `prependListener` / `prependOnceListener` — and
 *   `off` / `removeListener` / `removeAllListeners`, which can strip a guard (`removeAllListeners()`
 *   with no event strips every one);
 * - the same method reached as `process['on']`, through `globalThis.process` / `global.process`,
 *   through a local alias (`const p = process`), through a `node:process` (or `process`) default
 *   or namespace import, or as a named import of the method from it (`import { on } from
 *   'node:process'`);
 * - `once(process, <signal>)` / `on(process, <signal>)` — `node:events`' promise and iterator
 *   forms, called bare or as a member (`events.once`, `EventEmitter.on`) — with any of the process
 *   references above as the emitter.
 *
 * NOT caught: a process reference that only reaches the call through a function's parameter, an
 * object property, or any value the rule cannot follow to its declaration in the same file.
 *
 * Why: a terminating-signal handler written by hand is the shape that leaked a clone and a lock.
 * It removed itself on the first signal and started an asynchronous cleanup, so the second — a
 * terminal Ctrl-C under a wrapper that forwards signals delivers two — met the default disposition
 * and killed the process half-way through the cleanup. `handleTerminatingSignals` (on
 * `@vibe-agent-toolkit/utils/process`) is the one installation: it swallows the duplicate that
 * arrives with the first signal, composes with every other live guard, and dies of the signal. A
 * removal by hand can strip that guard's listener out from under it.
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
 * await once(process, 'SIGTERM');
 *
 * // GOOD
 * const guard = handleTerminatingSignals({ cleanup, fallbackExitCode: ExitCode.ERROR });
 * // ...
 * guard.release();
 */

'use strict';

const { createExemptPathMatcher } = require('./exempt-path-matcher.cjs');

const ADD_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const REMOVE_METHODS = new Set(['off', 'removeListener', 'removeAllListeners']);
/** `node:events`' static forms that take the emitter as their first argument. */
const EVENTS_STATIC_METHODS = new Set(['on', 'once']);
const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global']);
/** How many aliases deep a process reference is followed — `const a = process; const b = a;`. */
const MAX_ALIAS_DEPTH = 8;

/** The member name of `node` — `x.name` or `x['name']` — or null when it is not static. */
function memberName(node) {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

/** The variable `identifier` refers to, through the scope chain, or null for an unresolved global. */
function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

/** The import a variable is bound to: `{ module, imported }`, imported being 'default', '*' or a name. */
function importBinding(variable) {
  const def = variable?.defs?.[0];
  if (def?.type !== 'ImportBinding') return null;
  switch (def.node.type) {
    case 'ImportNamespaceSpecifier':
      return { module: def.parent?.source?.value, imported: '*' };
    case 'ImportDefaultSpecifier':
      return { module: def.parent?.source?.value, imported: 'default' };
    case 'ImportSpecifier': {
      const { imported } = def.node;
      return { module: def.parent?.source?.value, imported: imported.type === 'Identifier' ? imported.name : imported.value };
    }
    // `import p = require('node:process')` — the module object itself.
    case 'TSImportEqualsDeclaration':
      return { module: def.node.moduleReference?.expression?.value, imported: 'default' };
    default:
      return null;
  }
}

/** Whether `node` evaluates to the `process` object, as far as this file can tell. */
function isProcessRef(sourceCode, node, depth = 0) {
  if (depth > MAX_ALIAS_DEPTH) return false;
  if (node.type === 'MemberExpression') {
    return node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name) && memberName(node) === 'process';
  }
  if (node.type !== 'Identifier') return false;
  const variable = resolveVariable(sourceCode, node);
  if (variable === null || variable.defs.length === 0) return node.name === 'process';
  const binding = importBinding(variable);
  if (binding !== null) return PROCESS_MODULES.has(binding.module) && (binding.imported === 'default' || binding.imported === '*');
  const def = variable.defs[0];
  if (def.type !== 'Variable' || def.node.id.type !== 'Identifier' || def.node.init == null) return false;
  return isProcessRef(sourceCode, def.node.init, depth + 1);
}

/** The process method `callee` names — `process.on`, `p['once']`, an imported `on` — or null. */
function processMethod(sourceCode, callee) {
  const name = memberName(callee);
  if (name !== null) return isProcessRef(sourceCode, callee.object) ? name : null;
  if (callee.type !== 'Identifier') return null;
  const binding = importBinding(resolveVariable(sourceCode, callee));
  return binding !== null && PROCESS_MODULES.has(binding.module) ? binding.imported : null;
}

/** The literal text of an event-name argument, or null when it is not literal. */
function literalEventName(arg) {
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  if (arg.type === 'TemplateLiteral') return arg.quasis[0].value.cooked.startsWith('SIG') ? 'SIG' : null;
  return null;
}

/**
 * What `node` does to a signal listener — `{ method, eventArg, removal }` — or null when it is
 * not a listener call on the process at all.
 */
function listenerCall(sourceCode, node) {
  const { callee } = node;
  const method = processMethod(sourceCode, callee);
  if (method !== null && (ADD_METHODS.has(method) || REMOVE_METHODS.has(method))) {
    return { method, eventArg: node.arguments[0], removal: REMOVE_METHODS.has(method) };
  }
  const staticName = callee.type === 'Identifier' ? callee.name : memberName(callee);
  const [emitter, eventArg] = node.arguments;
  if (staticName !== null && EVENTS_STATIC_METHODS.has(staticName) && emitter !== undefined && isProcessRef(sourceCode, emitter)) {
    return { method: staticName, eventArg, removal: false };
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow adding or removing a process listener for a signal (or for any event not named ' +
        'literally) by hand — install a terminating-signal handler through handleTerminatingSignals',
      category: 'Filesystem and process',
      bans: '`process.on(<signal>, …)`, `process.off(<signal>, …)`, `once(process, <signal>)` and `process.on(<non-literal>, …)`',
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
        'handleTerminatingSignals from @vibe-agent-toolkit/utils/process: it swallows the ' +
        'duplicate that arrives with the first signal, composes with every other guard, and dies ' +
        'of the signal.',
      computedEvent:
        'process.{{method}}(<non-literal>) may be a signal handler installed by hand. Name the ' +
        'event literally, or — for a signal — use handleTerminatingSignals from ' +
        '@vibe-agent-toolkit/utils/process.',
      signalRemoval:
        'process.{{method}}({{event}}) removes a signal listener by hand, which can strip a ' +
        'handleTerminatingSignals guard out from under it. Release the guard instead.',
    },
  },

  create(context) {
    const allow = context.options?.[0]?.allow ?? [];
    const filename = context.filename ?? context.getFilename();
    if (createExemptPathMatcher(allow)(filename)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        const call = listenerCall(sourceCode, node);
        if (call === null) return;
        const { method, eventArg, removal } = call;
        if (eventArg === undefined) {
          // `removeAllListeners()` strips every listener, every guard's included.
          if (method === 'removeAllListeners') context.report({ node, messageId: 'signalRemoval', data: { method, event: '' } });
          return;
        }
        const event = literalEventName(eventArg);
        if (event !== null && !event.startsWith('SIG')) return;
        if (removal) {
          context.report({ node, messageId: 'signalRemoval', data: { method, event: event === null ? '<non-literal>' : `'${event}'` } });
        } else if (event === null) {
          context.report({ node, messageId: 'computedEvent', data: { method } });
        } else {
          context.report({ node, messageId: 'signalListener', data: { method, event } });
        }
      },
    };
  },
};
