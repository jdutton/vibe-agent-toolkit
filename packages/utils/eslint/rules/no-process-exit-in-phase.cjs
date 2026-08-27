/**
 * ESLint Rule: no-process-exit-in-phase
 *
 * Forbid `process.exit()` inside a phase entry point — a function whose name
 * ends in `Phase`.
 *
 * ## Why this rule exists
 *
 * `vat validate`, `vat verify` and `vat build` used to run each phase as a
 * SEPARATE CHILD PROCESS. A `process.exit()` inside a phase was then perfectly
 * safe: it ended that child, the parent read the exit code, and the run carried
 * on to the next phase. Nothing about the code said so — the safety came
 * entirely from the process boundary.
 *
 * That boundary is gone. Phases now run in the orchestrator's own process, so a
 * surviving `process.exit()` ends THE WHOLE RUN: every later phase is silently
 * skipped, the parent's aggregation never happens, and the process exits 0-or-1
 * having done half the work with nothing in the document to say so. It is the
 * worst shape of failure this codebase has — a confident, well-formed, wrong
 * answer — and it cannot be caught by a type, because `process.exit()`
 * typechecks anywhere.
 *
 * A phase must RETURN `{ document, exitCode }` and let its caller decide whether
 * to print and exit (a command-line run) or to fold the result into the run (an
 * orchestrated one).
 *
 * ## Why the name is the marker
 *
 * The `…Phase` suffix is the convention every phase entry point already follows
 * (`runResourcesValidatePhase`, `runSkillsBuildPhase`, …). Keying the rule to it
 * means a new phase is protected the moment it is named like one, with no list
 * to keep in sync — a list is the thing that goes stale silently, which is the
 * defect class this rule exists to prevent in the first place.
 *
 * The thin Commander wrappers that CALL these functions keep their
 * `process.exit()`: deciding how the process ends is exactly their job, and they
 * are not named `…Phase`.
 */

/** Does this call expression read as `process.exit(...)`? */
function isProcessExitCall(node) {
  const { callee } = node;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'process' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'exit'
  );
}

/**
 * The declared name of a function-ish node, however it was declared.
 *
 * Covers the three spellings a phase entry point can legitimately take: a
 * function declaration, a `const x = function () {}`, and a `const x = () => {}`.
 * A rule that only understood declarations would be silently inert against an
 * arrow const — the same blind spot `no-test-scoped-functions` documents.
 */
function functionName(node) {
  if (node.id && node.id.type === 'Identifier') return node.id.name;

  const { parent } = node;
  if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent && parent.type === 'Property' && parent.key.type === 'Identifier') {
    return parent.key.name;
  }
  return undefined;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** The nearest enclosing function named like a phase entry point, if any. */
function enclosingPhaseName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!FUNCTION_TYPES.has(current.type)) continue;
    const name = functionName(current);
    if (name !== undefined && name.endsWith('Phase')) return name;
  }
  return undefined;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid process.exit() inside a phase entry point, where it would end the whole orchestrated run',
      category: 'Agentic Code Safety',
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      exitInPhase:
        "'{{name}}' is a phase entry point, so process.exit() here ends the ENTIRE run — every later phase is skipped and the orchestrator never aggregates. Return { document, exitCode } instead and let the caller decide how the process ends.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (!isProcessExitCall(node)) return;
        const name = enclosingPhaseName(node);
        if (name === undefined) return;
        context.report({ node, messageId: 'exitInPhase', data: { name } });
      },
    };
  },
};
