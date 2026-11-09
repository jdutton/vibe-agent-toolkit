/**
 * ESLint rule: no-text-git-object-read
 *
 * A git argv that reads the OBJECT STORE — `ls-tree` (the paths a tree names),
 * `cat-file` (object contents), or a reader of committed history that prints
 * either (`diff-tree`, `rev-list`, `show`) — may only be handed to
 * `runGitBytes()`, as its first argument.
 *
 * Why: git holds paths and blobs as bytes, and a commit may hold bytes that are
 * not UTF-8. `runGit` hands stdout back decoded as UTF-8, which replaces every
 * invalid sequence with U+FFFD: distinct committed paths can come back as one
 * string, a path is judged under another spelling than the checkout writes, and
 * a `cat-file --batch` stream framed by byte counts changes length — a blob can
 * plant the next object's header. `runGitBytes` returns the bytes, and the caller
 * decodes them where it judges them.
 *
 * What it catches: an ARRAY LITERAL whose subcommand (its first element that is
 * not a global option, nor the value of `-c`/`-C`) is one of the above, anywhere
 * except as the first argument of a call to `runGitBytes` itself — so an argv
 * parked in a variable, or handed to a wrapper, is caught too.
 *
 * What it does not, stated rather than implied: an argv assembled from
 * non-literal parts or naming its subcommand through a variable; what a caller
 * does with the bytes afterwards (decoding them is the caller's judgment); and a
 * WORKING-TREE listing (`ls-files`), which is out of this rule's scope — see
 * `docs/contributing/known-defects.md`.
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
const OBJECT_READS = new Set(['ls-tree', 'cat-file', 'diff-tree', 'rev-list', 'show']);

/** Global options that take the NEXT element as their value. */
const VALUED_GLOBAL_OPTIONS = new Set(['-c', '-C']);

/** The argv's subcommand element — its first that is neither a global option nor one's value — or undefined. */
function subcommandOf(array) {
  let skipNext = false;
  for (const element of array.elements) {
    if (element?.type !== 'Literal' || typeof element.value !== 'string') return undefined;
    if (skipNext) {
      skipNext = false;
    } else if (VALUED_GLOBAL_OPTIONS.has(element.value)) {
      skipNext = true;
    } else if (!element.value.startsWith('-')) {
      return element;
    }
  }
  return undefined;
}

/** Whether `array` is the first argument of a call to `runGitBytes` itself. */
function handedToRunGitBytes(array) {
  const call = array.parent;
  return call?.type === 'CallExpression' && call.arguments[0] === array && calleeName(call) === 'runGitBytes';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow reading git's object store (`ls-tree`, `cat-file`, `diff-tree`, `rev-list`, `show`) through anything but runGitBytes() — " +
        'committed paths and blobs are bytes, and a text runner decodes them',
      category: 'Filesystem and process',
      bans: 'an argv whose subcommand reads the object store, unless it is the first argument of `runGitBytes(…)`',
      useInstead: '`runGitBytes()`, decoding the bytes where they are judged',
      subpath: '/git',
      recommended: false,
      recommendedSeverity: 'error',
    },
    schema: [],
    messages: {
      textRead:
        "git {{subcommand}} reads what the object store holds, as bytes that may not be UTF-8. Hand this argv to runGitBytes() " +
        "from '@vibe-agent-toolkit/utils/git' directly, and decode where you judge — a UTF-8 decode re-spells paths and shifts framing.",
    },
  },

  create(context) {
    return {
      ArrayExpression(node) {
        const subcommand = subcommandOf(node);
        if (subcommand === undefined || !OBJECT_READS.has(subcommand.value) || handedToRunGitBytes(node)) {
          return;
        }
        context.report({ node: subcommand, messageId: 'textRead', data: { subcommand: subcommand.value } });
      },
    };
  },
};
