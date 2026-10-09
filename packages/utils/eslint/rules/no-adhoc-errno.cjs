/**
 * ESLint rule: no-adhoc-errno
 *
 * Bans classifying a filesystem failure by hand. An errno name written as a string
 * in a classifying position is a private errno table, and every private table
 * decides a refusal code a little differently from its neighbours. One classifier
 * (`fsFaultOf` / `classifyFsFault`, plus the single-errno predicates such as
 * `isPathAbsentError`) owns the vocabulary; everything else asks it.
 *
 * Two reports:
 *
 * - `literal` — an errno name as a string that is (a) an operand of `===` `!==`
 *   `==` `!=`, (b) a `switch` `case` test, (c) an element of an array literal that
 *   is passed to `new Set(...)` or bound to a `const`, or (d) the argument of
 *   `.has()` / `.includes()`. (d) also catches the message match
 *   `errorMessage.includes('ENOENT')`, which hides an errno in prose.
 * - `adhocRefusal` — inside a `catch (e)`, a `new CommandRefusalError(...)` or
 *   `new VatError(...)` whose options carry `cause: e`, where the same catch body
 *   also reads `e.code` or calls `fsFaultOf(e)` / `isPathAbsentError(e)`. The catch
 *   is deciding the refusal itself; `classifyFsFault` decides it once.
 *
 * An inline array is a lookup table too: `['ENOENT', 'EACCES'].includes(e.code)` (and
 * `.some` / `.indexOf` / `.find` / `.findIndex` / `.every`). An identifier bound once
 * by `const` to an errno string (`const C = 'ENOENT'; e.code === C`) is flagged at its
 * use, and a template literal with no expressions counts as the string it spells.
 *
 * What counts as an errno is a SET, not a pattern: the union of
 * `os.constants.errno` across hosts, plus `EFTYPE` and `UNKNOWN` (libuv names Node
 * does not export) and `EHOSTDOWN` (which Node on macOS omits). A name that merely
 * looks like one (`EXAMPLE`) is not flagged, and `EOF` is not an errno, so it needs
 * no special case.
 *
 * Deliberately out of scope (each is a position this rule does not read):
 * - helper-call arguments, `isErr(e, 'ENOENT')`: the callee is the private table,
 *   and judging arbitrary calls would flag every legitimate use of a name;
 * - object literals, `{ code: 'ENOENT' }` / `{ ENOENT: 1 }`: those build or describe
 *   an error (fixtures, tables keyed by name), they do not classify one;
 * - dynamic strings, built with a template expression or `+`: not decidable statically.
 *
 * Exempt: test files, and the files named by `exemptFiles` (the ones that must name
 * errnos: the errno table, the git-stderr parser, the fault-injecting fs). No
 * default exemption ships, so a consumer declares its own.
 */

const {
  EXEMPT_FILES_SCHEMA,
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  isTestFile,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');

/**
 * The errno vocabulary, spelled out so the set is identical on every host.
 *
 * `os.constants.errno` differs by platform (Linux exports names macOS omits, and
 * macOS omits `EHOSTDOWN`), so reading it at lint time would make the rule pass on
 * one CI leg and fail on another. A rule module also may not require any external
 * module (`subpath-purity.test.ts`). So the union is written out here, and
 * `no-adhoc-errno.test.ts` fails if this host's `os.constants.errno` has a key the
 * list lacks. `EFTYPE` and `UNKNOWN` are libuv names Node does not export.
 */
const ERRNO_NAMES = new Set([
  'E2BIG', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAGAIN', 'EALREADY',
  'EBADF', 'EBADMSG', 'EBUSY', 'ECANCELED', 'ECHILD', 'ECONNABORTED', 'ECONNREFUSED',
  'ECONNRESET', 'EDEADLK', 'EDESTADDRREQ', 'EDOM', 'EDQUOT', 'EEXIST', 'EFAULT', 'EFBIG',
  'EHOSTUNREACH', 'EIDRM', 'EILSEQ', 'EINPROGRESS', 'EINTR', 'EINVAL', 'EIO', 'EISCONN',
  'EISDIR', 'ELOOP', 'EMFILE', 'EMLINK', 'EMSGSIZE', 'EMULTIHOP', 'ENAMETOOLONG', 'ENETDOWN',
  'ENETRESET', 'ENETUNREACH', 'ENFILE', 'ENOBUFS', 'ENODATA', 'ENODEV', 'ENOENT', 'ENOEXEC',
  'ENOLCK', 'ENOLINK', 'ENOMEM', 'ENOMSG', 'ENOPROTOOPT', 'ENOSPC', 'ENOSR', 'ENOSTR',
  'ENOSYS', 'ENOTCONN', 'ENOTDIR', 'ENOTEMPTY', 'ENOTSOCK', 'ENOTSUP', 'ENOTTY', 'ENXIO',
  'EOPNOTSUPP', 'EOVERFLOW', 'EPERM', 'EPIPE', 'EPROTO', 'EPROTONOSUPPORT', 'EPROTOTYPE',
  'ERANGE', 'EROFS', 'ESPIPE', 'ESRCH', 'ESTALE', 'ETIME', 'ETIMEDOUT', 'ETXTBSY',
  'EWOULDBLOCK', 'EXDEV',
  // Linux-only names:
  'EADV', 'EBADE', 'EBADFD', 'EBADR', 'EBADRQC', 'EBADSLT', 'EBFONT', 'ECHRNG', 'ECOMM',
  'EDEADLOCK', 'EDOTDOT', 'EISNAM', 'EKEYEXPIRED', 'EKEYREJECTED', 'EKEYREVOKED', 'EL2HLT',
  'EL2NSYNC', 'EL3HLT', 'EL3RST', 'ELIBACC', 'ELIBBAD', 'ELIBEXEC', 'ELIBMAX', 'ELIBSCN',
  'ELNRNG', 'EMEDIUMTYPE', 'ENAVAIL', 'ENOANO', 'ENOKEY', 'ENOMEDIUM', 'ENONET', 'ENOPKG',
  'ENOTBLK', 'ENOTNAM', 'ENOTRECOVERABLE', 'ENOTUNIQ', 'EOWNERDEAD', 'EPFNOSUPPORT', 'EREMCHG',
  'EREMOTE', 'EREMOTEIO', 'ERESTART', 'ERFKILL', 'ESHUTDOWN', 'ESOCKTNOSUPPORT', 'ESRMNT',
  'ESTRPIPE', 'ETOOMANYREFS', 'EUCLEAN', 'EUNATCH', 'EUSERS', 'EXFULL',
  // Not in os.constants.errno on every host:
  'EFTYPE', 'UNKNOWN', 'EHOSTDOWN',
]);

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=']);
const MEMBERSHIP_METHODS = new Set(['has', 'includes']);
/** Methods that make an INLINE array literal a lookup table: `['ENOENT'].includes(e.code)`. */
const ARRAY_LOOKUP_METHODS = new Set(['includes', 'some', 'indexOf', 'find', 'findIndex', 'every']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const REFUSAL_CLASSES = new Set(['CommandRefusalError', 'VatError']);
const ERRNO_PREDICATES = new Set(['fsFaultOf', 'isPathAbsentError']);

/**
 * The string a literal spells: a string `Literal`, or a template literal with no
 * expressions (a backticked ENOENT is the same literal).
 *
 * @returns {string | undefined}
 */
function literalText(node) {
  if (node?.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : undefined;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? undefined;
  }
  return undefined;
}

/** @returns {boolean} True when `node` is a string literal naming an errno. */
function isErrnoLiteral(node) {
  const text = literalText(node);
  return text !== undefined && ERRNO_NAMES.has(text);
}

/** The declaring variable of an identifier, found by walking out through its scopes. */
function resolveVariable(sourceCode, node) {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) {
      return variable;
    }
  }
  return undefined;
}

/** True when `node` is an identifier bound once, by `const`, to an errno literal. */
function isConstErrnoAlias(sourceCode, node) {
  if (node.type !== 'Identifier') {
    return false;
  }
  const variable = resolveVariable(sourceCode, node);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  return (
    definition?.type === 'Variable' &&
    definition.parent?.kind === 'const' &&
    definition.node.id.type === 'Identifier' &&
    isErrnoLiteral(unwrapExpression(definition.node.init))
  );
}

/** Step over `as const`, `satisfies` and `!` wrappers to the expression inside. */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/** The array literal's enclosing context: the thing that makes it a lookup table. */
function isLookupArray(arrayNode) {
  // Climb through `as const` wrappers so `['ENOENT'] as const` is seen as bound.
  let child = arrayNode;
  let parent = arrayNode.parent;
  while (parent && unwrapExpression(parent) !== parent && parent.expression === child) {
    child = parent;
    parent = parent.parent;
  }
  if (parent?.type === 'MemberExpression') {
    return (
      parent.object === child &&
      !parent.computed &&
      parent.property.type === 'Identifier' &&
      ARRAY_LOOKUP_METHODS.has(parent.property.name)
    );
  }
  if (parent?.type === 'NewExpression') {
    return parent.callee.type === 'Identifier' && parent.callee.name === 'Set' && parent.arguments[0] === child;
  }
  return (
    parent?.type === 'VariableDeclarator' &&
    parent.init === child &&
    parent.parent?.type === 'VariableDeclaration' &&
    parent.parent.kind === 'const'
  );
}

/** @returns {boolean} True when the literal sits in one of the four classifying positions. */
function isClassifyingPosition(node) {
  const parent = node.parent;
  switch (parent?.type) {
    case 'BinaryExpression':
      return COMPARISON_OPERATORS.has(parent.operator);
    case 'SwitchCase':
      return parent.test === node;
    case 'ArrayExpression':
      return isLookupArray(parent);
    case 'CallExpression':
      return (
        parent.arguments.includes(node) &&
        parent.callee.type === 'MemberExpression' &&
        !parent.callee.computed &&
        parent.callee.property.type === 'Identifier' &&
        MEMBERSHIP_METHODS.has(parent.callee.property.name)
      );
    default:
      return false;
  }
}

/** Every AST child of `node`, skipping the back-pointer. */
function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item.type === 'string') {
        children.push(item);
      }
    }
  }
  return children;
}

/**
 * Collect every node under `root` (inclusive) that `predicate` accepts, without
 * descending into a nested catch or function: those judge their own bodies, so a
 * re-wrap is reported once, by the catch that owns it.
 */
function collectNodes(root, predicate) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (predicate(node)) {
      found.push(node);
    }
    if (node.type !== 'CatchClause' && !FUNCTION_TYPES.has(node.type)) {
      pending.push(...childNodes(node));
    }
  }
  return found;
}

const isIdentifier = (node, name) => node?.type === 'Identifier' && node.name === name;

/** `e.code`, `fsFaultOf(e)` or `isPathAbsentError(e)` for the catch parameter `name`. */
function inspectsErrno(node, name) {
  if (node.type === 'MemberExpression') {
    return (
      isIdentifier(node.object, name) &&
      ((!node.computed && isIdentifier(node.property, 'code')) ||
        (node.computed && node.property.type === 'Literal' && node.property.value === 'code'))
    );
  }
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    ERRNO_PREDICATES.has(node.callee.name) &&
    isIdentifier(node.arguments[0], name)
  );
}

/** `new CommandRefusalError(...)` / `new VatError(...)` carrying `cause: <name>`. */
function wrapsCause(node, name) {
  return (
    node.type === 'NewExpression' &&
    node.callee.type === 'Identifier' &&
    REFUSAL_CLASSES.has(node.callee.name) &&
    node.arguments.some(
      (argument) =>
        argument.type === 'ObjectExpression' &&
        argument.properties.some(
          (property) =>
            property.type === 'Property' &&
            !property.computed &&
            (isIdentifier(property.key, 'cause') || property.key.value === 'cause') &&
            isIdentifier(property.value, name),
        ),
    )
  );
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban classifying a filesystem failure by hand: an errno name as a string in a comparison, case, Set/const array or .has()/.includes(), and a catch that inspects the errno then wraps it as a refusal cause',
      category: 'Filesystem and process',
      bans: 'an errno name (`ENOENT`, `EACCES`, …) as a string in a classifying position, and a catch that reads `e.code` then builds a refusal with `cause: e`',
      useInstead: '`fsFaultOf(e)` / `classifyFsFault(e, …)`, or a single-errno predicate such as `isPathAbsentError(e)`',
      // Not in `recommended`: the remedy names this repo's own classifier
      // (`fsFaultOf`, `classifyFsFault`) and the refusal classes `CommandRefusalError` /
      // `VatError`, none of which an adopter has. VAT enables it explicitly, naming
      // the files that must spell errnos (the table, the git-stderr parser, the
      // fault-injecting fs).
      recommended: false,
      recommendedSeverity: 'error',
    },
    fixable: null,
    schema: [EXEMPT_FILES_SCHEMA],
    messages: {
      literal:
        "Errno name '{{name}}' written as a string classifies a filesystem failure by hand. " +
        'Ask the one classifier instead: fsFaultOf(e)?.faultClass, classifyFsFault(e, …), or a ' +
        'single-errno predicate such as isPathAbsentError(e). A private errno table drifts from its neighbours.',
      adhocRefusal:
        'This catch inspects the errno ({{param}}.code / fsFaultOf / isPathAbsentError) and then builds a refusal ' +
        'with cause: {{param}} by hand. Let classifyFsFault({{param}}, …) pick the refusal once.',
      [UNANCHORED_EXEMPT_FILE]: UNANCHORED_EXEMPT_MESSAGE,
    },
  },

  create(context) {
    const filename = context.getFilename();

    if (createConfigurableExemptPathMatcher([])(context)(filename)) {
      // Still surface a malformed exemption list: this file may be exempt only
      // BECAUSE an entry is unanchored.
      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },
      };
    }

    if (isTestFile(filename)) {
      return {};
    }

    return {
      Program(node) {
        reportUnanchoredExemptEntries(context, node);
      },

      'Literal, TemplateLiteral'(node) {
        if (isErrnoLiteral(node) && isClassifyingPosition(node)) {
          context.report({ node, messageId: 'literal', data: { name: literalText(node) } });
        }
      },

      // `const C = 'ENOENT'; e.code === C`: flagged at the use, where the check is.
      Identifier(node) {
        if (isClassifyingPosition(node) && isConstErrnoAlias(context.sourceCode, node)) {
          context.report({ node, messageId: 'literal', data: { name: node.name } });
        }
      },

      CatchClause(node) {
        if (node.param?.type !== 'Identifier') {
          return;
        }
        const param = node.param.name;
        if (collectNodes(node.body, (child) => inspectsErrno(child, param)).length === 0) {
          return;
        }
        for (const wrapped of collectNodes(node.body, (child) => wrapsCause(child, param))) {
          context.report({ node: wrapped, messageId: 'adhocRefusal', data: { param } });
        }
      },
    };
  },
};
