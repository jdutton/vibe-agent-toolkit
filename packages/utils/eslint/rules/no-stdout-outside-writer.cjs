/**
 * ESLint rule: no-stdout-outside-writer
 *
 * Under the configured `paths` (a CLI's command directory), stdout belongs to
 * ONE writer. A command that writes its own bytes publishes a shape nothing
 * validates, in a format it chose, beside an exit code it decided — which is
 * how a CLI grows one document contract per verb. The writer validates the
 * document against its registered schema before a byte leaves and derives the
 * exit code from what it wrote; this rule makes it the only way out.
 *
 * Reported under `paths` (test files excepted):
 *
 * - `process.stdout.write(…)`;
 * - `console.log|info|debug|dir|table(…)` — the console methods that write
 *   stdout (`console.error` / `console.warn` are stderr, the human channel,
 *   and are not this rule's business);
 * - a call to a stdout-writing helper BY NAME — `writeStdoutSync`,
 *   `writeAllSync`, bare or as a member — and one HANDED ON as an argument
 *   (`render(result, writeStdoutSync)`), which writes stdout just the
 *   same. A rule that saw only the primitives was blind to every command that
 *   writes through a helper.
 *
 * Option `allowFiles: string[]` — repo-relative files whose stdout is not a
 * document (a protocol leaf). Asserted both ways: a listed file with no
 * violation left is itself an error (`staleAllow`), so the list never holds a
 * dead entry.
 *
 * @example
 * // BAD — a shape nothing validates, beside a code decided here
 * writeStdoutSync(yaml.stringify(result));
 * process.stdout.write(`${JSON.stringify(result)}\n`);
 *
 * // GOOD — validated against the registry, exit derived from what was written
 * endWithReport('okf validate', report, format);
 */

'use strict';

const { createExemptDirectoryMatcher, createExemptPathMatcher, isTestFile } = require('./exempt-path-matcher.cjs');

/** The `console` methods that write stdout. */
const STDOUT_CONSOLE_METHODS = new Set(['log', 'info', 'debug', 'dir', 'table']);

/** Helpers that write stdout, recognised by name wherever they are imported from. */
const STDOUT_HELPERS = new Set([
  'writeStdoutSync',
  'writeAllSync',
]);

/** Whether `node` is `<object>.<property>` (non-computed) with an identifier object. */
function isMember(node, object, property) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    (property === undefined || node.property.name === property) &&
    (object === undefined || (node.object.type === 'Identifier' && node.object.name === object))
  );
}

/** Whether `callee` is `process.stdout.write`. */
function isProcessStdoutWrite(callee) {
  return isMember(callee, undefined, 'write') && isMember(callee.object, 'process', 'stdout');
}

/** The called function's own name — `f(…)` or `x.f(…)` — or null. */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (isMember(callee)) return callee.property.name;
  return null;
}

/** Whether a call writes stdout by one of the routes this rule reports. */
function writesStdout(callee) {
  if (isProcessStdoutWrite(callee)) return true;
  if (isMember(callee, 'console') && STDOUT_CONSOLE_METHODS.has(callee.property.name)) return true;
  return STDOUT_HELPERS.has(calleeName(callee));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow writing stdout under a command directory except through the one document writer — ' +
        'process.stdout.write, console.log and the stdout helpers publish a shape nothing validates',
      // A position on one CLI's architecture: it names that CLI's command
      // directory and its writer, which no adopter's layout shares.
      recommended: false,
    },
    schema: [
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        required: ['paths', 'allowFiles'],
        additionalProperties: false,
      },
    ],
    messages: {
      stdoutOutsideWriter:
        'stdout is written by the document writer only (endWithReport / endWithRefusal / ' +
        'writeExternalDocument / writeArtifact). A command that writes its own bytes publishes a ' +
        'shape nothing validates, beside an exit code it decided.',
      staleAllow:
        'This file is listed in no-stdout-outside-writer allowFiles but writes stdout by no ' +
        'reported route any more. Remove it from the list — the ratchet only shrinks.',
    },
  },

  create(context) {
    const options = context.options?.[0] ?? { paths: [], allowFiles: [] };
    const filename = context.filename ?? context.getFilename();
    if (isTestFile(filename) || !createExemptDirectoryMatcher(options.paths)(filename)) {
      return {};
    }
    const allowed = createExemptPathMatcher(options.allowFiles)(filename);
    let violations = 0;

    return {
      CallExpression(node) {
        const handedOn = node.arguments.filter((arg) => arg.type === 'Identifier' && STDOUT_HELPERS.has(arg.name));
        const sites = writesStdout(node.callee) ? [node, ...handedOn] : handedOn;
        violations += sites.length;
        if (allowed) return;
        for (const site of sites) context.report({ node: site, messageId: 'stdoutOutsideWriter' });
      },
      'Program:exit'(node) {
        if (allowed && violations === 0) context.report({ node, messageId: 'staleAllow' });
      },
    };
  },
};
