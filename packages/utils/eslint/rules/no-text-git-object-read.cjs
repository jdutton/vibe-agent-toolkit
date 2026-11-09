/**
 * ESLint rule: no-text-git-object-read
 *
 * A git argv that reads the object store — `ls-tree` (committed paths) or
 * `cat-file` (object contents) — may only be handed to a BYTES runner: a call
 * whose callee name ends in `Bytes` (`runGitBytes(…)`, or a wrapper of it).
 *
 * Why: git holds paths and blobs as bytes, and a commit may hold bytes that are
 * not UTF-8. `runGit` hands stdout back decoded as UTF-8, which replaces every
 * invalid sequence with U+FFFD: two committed paths can come back as one string,
 * a path is judged under another spelling than the checkout writes, and a
 * `cat-file --batch` stream framed by byte counts changes length — a blob can
 * plant the next object's header. `runGitBytes` returns the bytes, and the caller
 * decodes them where it judges them.
 *
 * What it catches: an ARRAY LITERAL holding the string `'ls-tree'` or `'cat-file'`
 * anywhere except as the first argument of a `…Bytes(…)` call — so an argv built
 * into a variable first is caught too. What it does not: an argv assembled from
 * non-literal parts, or a subcommand passed as a variable.
 *
 * @example
 * // BAD
 * runGit(['ls-tree', '-r', '-z', commit], { cwd });
 *
 * // GOOD
 * runGitBytes(['ls-tree', '-r', '-z', commit], { cwd });
 */

'use strict';

const { calleeName } = require('./callee-name.cjs');

/** The subcommands whose output is what the object store holds. */
const OBJECT_READS = new Set(['ls-tree', 'cat-file']);

/** Whether `array` is the first argument of a call through a `…Bytes` callee. */
function handedToBytesRunner(array) {
  const call = array.parent;
  if (call?.type !== 'CallExpression' || call.arguments[0] !== array) {
    return false;
  }
  const name = calleeName(call);
  return name !== null && name.endsWith('Bytes');
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow reading git's object store (`ls-tree`, `cat-file`) through a runner that decodes stdout as text — " +
        'committed paths and blobs are bytes; read them with runGitBytes()',
      category: 'Filesystem and process',
      bans: "an argv holding `'ls-tree'` or `'cat-file'` that is not the first argument of a `…Bytes(…)` call",
      useInstead: '`runGitBytes()`, decoding the bytes where they are judged',
      subpath: '/git',
      recommended: false,
      recommendedSeverity: 'error',
    },
    schema: [],
    messages: {
      textRead:
        "git {{subcommand}} reads what the object store holds, as bytes that may not be UTF-8. Hand this argv to runGitBytes() " +
        "from '@vibe-agent-toolkit/utils/git' (or a …Bytes wrapper of it) and decode where you judge — a UTF-8 decode re-spells paths and shifts framing.",
    },
  },

  create(context) {
    return {
      ArrayExpression(node) {
        const read = node.elements.find((element) => element?.type === 'Literal' && OBJECT_READS.has(element.value));
        if (read === undefined || handedToBytesRunner(node)) {
          return;
        }
        context.report({ node: read, messageId: 'textRead', data: { subcommand: read.value } });
      },
    };
  },
};
