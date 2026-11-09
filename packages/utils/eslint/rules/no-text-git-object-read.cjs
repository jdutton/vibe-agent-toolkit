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
 * What it catches: an ARRAY LITERAL that reaches a call or `new` — as an
 * argument (through `as`, `satisfies`, `!` or a branch of `?:`), or through a
 * variable it initializes — that does not name another program as its first
 * argument (`spawnSync('npm', […])`; `git`, `/usr/bin/git` and `git.exe` are git), whose subcommand (its first element that is
 * not a global option, nor the value of `-c`, `-C`, `--git-dir`, `--work-tree`,
 * `--namespace` or `--config-env`, past any leading spread) is one of the above,
 * unless it is the first argument of a call to `runGitBytes` itself. So an argv
 * parked in a variable, or handed to a wrapper, is caught too.
 *
 * What it does not, stated rather than implied: an argv built by `push` or from
 * a subcommand held in a variable; one assigned after its declaration
 * (`a = [...]`), returned from a function, or held in an object property; a
 * local function that is itself named `runGitBytes`; what a caller does with the bytes afterwards
 * (decoding them is the caller's judgment); other subcommands that can print
 * committed paths (`diff --name-only`, `log --name-only`, `archive`, `grep
 * <tree>`), which VAT does not run against a commit it judges; and a WORKING-TREE
 * listing (`ls-files`), out of scope — see `docs/contributing/known-defects.md`.
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

/** A program that is git: bare, by a path (`/usr/bin/git`, `C:\…\git.exe`), with or without `.exe`, any case. */
const GIT_PROGRAM = /(?:^|[\\/])git(?:\.exe)?$/i;

/** Global options that take the NEXT element as their value (`--git-dir=<d>` spellings start with `-` and are skipped anyway). */
const VALUED_GLOBAL_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);

/** An element's static string — a string literal, or a template with no expressions — or undefined. */
function staticString(element) {
  if (element?.type === 'Literal' && typeof element.value === 'string') return element.value;
  if (element?.type === 'TemplateLiteral' && element.expressions.length === 0) return element.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/**
 * The argv's subcommand — its first element that is neither a global option nor one's value — as
 * `{ node, value }`, or undefined. A leading spread (`...configArgs`, global options by convention)
 * is passed over; any other element whose string is not static ends the search.
 */
function subcommandOf(array) {
  let skipNext = false;
  for (const element of array.elements) {
    const value = staticString(element);
    if (skipNext) {
      skipNext = false;
    } else if (element?.type === 'SpreadElement') {
      // Global options spread in front of the subcommand: keep looking.
    } else if (value === undefined) {
      return undefined;
    } else if (VALUED_GLOBAL_OPTIONS.has(value)) {
      skipNext = true;
    } else if (!value.startsWith('-')) {
      return { node: element, value };
    }
  }
  return undefined;
}

/** Expressions that hand their operand on unchanged: a type assertion, `satisfies`, `!`, a branch of `?:`. */
const PASS_THROUGH = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ConditionalExpression']);

/** `node` with every {@link PASS_THROUGH} around it: the expression its value arrives as. */
function outermost(node) {
  let at = node;
  while (PASS_THROUGH.has(at.parent?.type) && (at.parent.type !== 'ConditionalExpression' || at.parent.test !== at)) at = at.parent;
  return at;
}

/**
 * Whether a call runs another program than git: its first argument is a string literal naming one
 * (`spawnSync('npm', ['show', pkg])`). A call naming no program is assumed to run git.
 */
function runsOtherProgram(call) {
  const program = staticString(call.arguments[0]);
  return program !== undefined && !GIT_PROGRAM.test(program);
}

/** Whether `node` is an argument of a call or `new` that may run git, directly or spread into an array that is. */
function isCallArgument(node) {
  const value = outermost(node);
  const { parent } = value;
  if (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') return parent.arguments.includes(value) && !runsOtherProgram(parent);
  if (parent?.type === 'SpreadElement' && parent.parent?.type === 'ArrayExpression') return isCallArgument(parent.parent);
  return false;
}

/**
 * Whether the argv reaches a call: it is a call's argument, or it initializes a variable that one of
 * its references hands to a call. An array of words that never reaches a call (`['show', 'hide']`
 * tested with `.includes`) is not an argv.
 */
function reachesCall(context, array) {
  if (isCallArgument(array)) return true;
  const value = outermost(array);
  const declarator = value.parent;
  if (declarator?.type !== 'VariableDeclarator' || declarator.init !== value) return false;
  return context.sourceCode
    .getDeclaredVariables(declarator)
    .some((variable) => variable.references.some((reference) => isCallArgument(reference.identifier)));
}

/** Whether `array` is the first argument of a call to `runGitBytes` itself. */
function handedToRunGitBytes(array) {
  const value = outermost(array);
  const call = value.parent;
  return call?.type === 'CallExpression' && call.arguments[0] === value && calleeName(call) === 'runGitBytes';
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
        if (subcommand === undefined || !OBJECT_READS.has(subcommand.value) || handedToRunGitBytes(node) || !reachesCall(context, node)) {
          return;
        }
        context.report({ node: subcommand.node, messageId: 'textRead', data: { subcommand: subcommand.value } });
      },
    };
  },
};
