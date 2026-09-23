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
 * ## Option `derived` — the code is DERIVED from the document, not chosen
 *
 * Naming a member is not enough. `process.exit(refused ? ExitCode.FINDINGS :
 * ExitCode.OK)` names members and still re-decides, beside the document, what
 * the document means — and one outcome shipped with different codes in
 * different verbs that way (a budget kill 1-or-2 by timing; an unreadable root
 * 2 in one verb and 1 in another). Under `derived.paths`:
 *
 * - `ExitCode.FINDINGS` may not be NAMED at all. "What it examined failed its
 *   gate" is a claim about a published document, so it comes from
 *   `exitCodeForReport(document)` (`@vibe-agent-toolkit/schema`) and nowhere else.
 * - `process.exit(x)` / `process.exitCode = x` takes `ExitCode.OK`,
 *   `ExitCode.ERROR`, or a call to one of `derived.calls` (the derivations:
 *   `exitCodeForReport`, `exitCodeOfChild`, …). A ternary, a variable or a
 *   forwarded field is a code decided somewhere this rule cannot see.
 * - `derived.legacy` names the files not yet migrated. It is a RATCHET asserted
 *   both ways: a listed file that no longer decides a code by hand is itself an
 *   error (`staleLegacy`), so the list can only shrink and never holds a dead entry.
 *
 * ⚠️ What this cannot see: a document verb ending on a bare `ExitCode.OK` over a
 * document that says `error`. That is a runtime fact, pinned by the exit-code
 * matrix system test, not a syntactic one.
 *
 * @example
 * // BAD — 1 means what, exactly?
 * process.exit(1);
 *
 * // BAD under `derived` — the call site decides what the document means
 * process.exit(errors > 0 ? ExitCode.FINDINGS : ExitCode.OK);
 *
 * // GOOD — derived from what was published
 * process.exit(exitCodeForReport(report));
 */

'use strict';

const { createExemptDirectoryMatcher, createExemptPathMatcher, isTestFile } = require('./exempt-path-matcher.cjs');

/** The members a call site may name outright: neither is a claim about a document. */
const UNDERIVED_MEMBERS = new Set(['OK', 'ERROR']);

/** Whether `node` is `ExitCode.<name>` (non-computed). */
function isExitCodeMember(node, name) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'ExitCode' &&
    node.property.type === 'Identifier' &&
    (name === undefined ? UNDERIVED_MEMBERS.has(node.property.name) : node.property.name === name)
  );
}

/** The called function's own name — `f(…)` or `x.f(…)` — or null. */
function calleeName(node) {
  if (node.type !== 'CallExpression') return null;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

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
          derived: {
            type: 'object',
            properties: {
              paths: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              calls: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              legacy: { type: 'array', items: { type: 'string' }, uniqueItems: true },
            },
            required: ['paths', 'calls', 'legacy'],
            additionalProperties: false,
          },
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
      findingsNotDerived:
        'ExitCode.FINDINGS is a claim about a published document ("what it examined failed its ' +
        'gate"). Derive it: process.exit(exitCodeForReport(document)) — never name it at a call site.',
      exitNotDerived:
        'This exit code is decided here, beside the document, where it can disagree with it. Exit ' +
        'with ExitCode.OK, ExitCode.ERROR, or a derivation: {{calls}}.',
      staleLegacy:
        'This file is listed in no-literal-process-exit derived.legacy but decides no exit code by ' +
        'hand any more. Remove it from the list — the ratchet only shrinks.',
    },
  },

  create(context) {
    const allow = context.options?.[0]?.allow ?? [];
    const derived = context.options?.[0]?.derived;
    const filename = context.filename ?? context.getFilename();
    if (createExemptPathMatcher(allow)(filename)) {
      return {};
    }

    const inDerived = derived !== undefined
      && !isTestFile(filename)
      && createExemptDirectoryMatcher(derived.paths)(filename);
    const isLegacy = inDerived && createExemptPathMatcher(derived.legacy)(filename);
    const derivations = new Set(derived?.calls ?? []);
    let handDecided = 0;

    /** Report a derivation violation — or, in a legacy file, only count it. */
    function reportDerived(node, messageId) {
      handDecided += 1;
      if (isLegacy) return;
      context.report({ node, messageId, data: { calls: [...derivations].join(', ') } });
    }

    /** @returns {boolean} Whether a literal was reported (so nothing else is). */
    function reportLiteral(node, expr, messageId) {
      const leaf = numericLiteralLeaf(expr);
      if (leaf === null) return false;
      context.report({ node, messageId, data: { literal: String(leaf.raw ?? leaf.value) } });
      return true;
    }

    function checkExitValue(node, expr, literalMessageId) {
      if (reportLiteral(node, expr, literalMessageId) || !inDerived) return;
      if (isExitCodeMember(expr) || derivations.has(calleeName(expr))) return;
      // `ExitCode.FINDINGS` itself is reported by the member visitor below.
      if (isExitCodeMember(expr, 'FINDINGS')) return;
      reportDerived(node, 'exitNotDerived');
    }

    return {
      CallExpression(node) {
        if (isProcessMember(node.callee, 'exit') && node.arguments.length > 0) {
          checkExitValue(node, node.arguments[0], 'literalExit');
        }
      },
      AssignmentExpression(node) {
        if (isProcessMember(node.left, 'exitCode')) {
          checkExitValue(node, node.right, 'literalExitCode');
        }
      },
      MemberExpression(node) {
        if (inDerived && isExitCodeMember(node, 'FINDINGS')) reportDerived(node, 'findingsNotDerived');
      },
      'Program:exit'(node) {
        if (isLegacy && handDecided === 0) context.report({ node, messageId: 'staleLegacy' });
      },
    };
  },
};
