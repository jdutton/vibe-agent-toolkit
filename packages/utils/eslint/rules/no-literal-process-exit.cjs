/**
 * ESLint rule: no-literal-process-exit
 *
 * Flags `process.exit(<number>)` and `process.exitCode = <number>`. A numeric
 * exit code written at the call site re-decides the exit contract inline: one
 * command exits 1 for "findings" and another exits 1 for "the config was
 * unreadable", and nothing but a reader comparing two files can tell. The
 * allowed shape names the meaning — `process.exit(ExitCode.FINDINGS)` — so the
 * contract lives in one enum and every command shares it.
 *
 * The literal may hide inside an expression: `ok ? 0 : 1`, `status ?? 1`,
 * `-1`. Those are flagged too, because each branch is still a number chosen at
 * this site. Any non-literal argument — an identifier, a member, a call
 * result — is accepted; the rule is a syntactic floor and does not chase what
 * a variable holds.
 *
 * Option `allow: string[]` — repo-relative paths of the files permitted to
 * exit with a literal (the one `bin.ts` last-resort fallback that runs when
 * the enum module itself failed to load). Entries are matched at a path
 * segment boundary via `exempt-path-matcher.cjs`; give the full repo-relative
 * path, not a bare basename.
 *
 * @example
 * // BAD — 1 means what, exactly?
 * process.exit(1);
 *
 * // GOOD — the meaning is the code
 * process.exit(ExitCode.FINDINGS);
 */

'use strict';

const { createExemptPathMatcher } = require('./exempt-path-matcher.cjs');

/** Whether `node` is the member expression `process.<name>` (non-computed). */
function isProcessMember(node, name) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'process' &&
    node.property.type === 'Identifier' &&
    node.property.name === name
  );
}

/**
 * The first numeric literal reachable through the expression's value
 * branches, or null. Walks conditionals, nullish/logical fallbacks, unary
 * minus, and TypeScript wrappers — every path a number can take to become the
 * exit code without passing through a name.
 */
function numericLiteralLeaf(expr) {
  switch (expr.type) {
    case 'Literal':
      return typeof expr.value === 'number' ? expr : null;
    case 'UnaryExpression':
      return numericLiteralLeaf(expr.argument);
    case 'ConditionalExpression':
      return numericLiteralLeaf(expr.consequent) ?? numericLiteralLeaf(expr.alternate);
    case 'LogicalExpression':
      return numericLiteralLeaf(expr.left) ?? numericLiteralLeaf(expr.right);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      return numericLiteralLeaf(expr.expression);
    default:
      return null;
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow process.exit(<number>) and process.exitCode = <number> — name the meaning with ' +
        'the ExitCode enum so every command shares one exit contract',
      recommended: false,
      recommendedSeverity: 'warn',
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
      literalExit:
        'process.exit({{literal}}) re-decides the exit contract at this call site. Use the ' +
        'ExitCode enum from @vibe-agent-toolkit/schema — process.exit(ExitCode.X) — so the code ' +
        'means the same thing in every command.',
      literalExitCode:
        'process.exitCode = {{literal}} re-decides the exit contract at this site. Assign an ' +
        'ExitCode member from @vibe-agent-toolkit/schema instead.',
    },
  },

  create(context) {
    const allow = context.options?.[0]?.allow ?? [];
    const filename = context.filename ?? context.getFilename();
    if (createExemptPathMatcher(allow)(filename)) {
      return {};
    }

    function reportLiteral(node, expr, messageId) {
      const leaf = numericLiteralLeaf(expr);
      if (leaf !== null) {
        context.report({ node, messageId, data: { literal: String(leaf.raw ?? leaf.value) } });
      }
    }

    return {
      CallExpression(node) {
        if (isProcessMember(node.callee, 'exit') && node.arguments.length > 0) {
          reportLiteral(node, node.arguments[0], 'literalExit');
        }
      },
      AssignmentExpression(node) {
        if (isProcessMember(node.left, 'exitCode')) {
          reportLiteral(node, node.right, 'literalExitCode');
        }
      },
    };
  },
};
