/**
 * ESLint rule: no-destructive-fs
 *
 * Bans every recursive remove, rename and copy of a filesystem tree outside the one
 * module that owns them. A hand-rolled `rm` + `rename` + `cp` sequence is a private
 * swap protocol, and each one decided differently what happens when the disk fills, a
 * file is unreadable, a name differs only by case, or the process dies between two
 * steps. The tree-change primitive (`planTreeChanges` / `applyTreePlan`, plus
 * `replaceFile`, `renameFileAtomic`, `withTempDir`, `disposeTempDir`, `copyTree`) is
 * the single protocol; everything else asks it.
 *
 * The rule judges REFERENCES to a banned function, not only calls, using the scope
 * manager. A binding is banned when it comes from `node:fs` / `node:fs/promises` (or
 * the unprefixed names) by named import (`import { rmSync as r }`), by destructuring a
 * namespace (`const { rmSync } = fs`, `const { promises: { rm } } = fs`), or by a
 * dynamic `import()` / `require()`; a namespace is a default or namespace import, a
 * `promises` binding, `fs.promises`, an alias of one, or a dynamic `import()` /
 * `require()`. A local that shadows an imported name is not the fs function.
 *
 * - `recursiveRm` — `rm` / `rmSync`, unless the reference is a call whose options are
 *   provably non-recursive: an object literal with no `recursive` key or `recursive:
 *   false`. An identifier, a call, a spread (`rmSync(...args)`), a computed key, a
 *   non-literal value, or a use as a value (`names.map(rmSync)`, `.call`, `.apply`)
 *   counts as recursive. `rm(file)` and `rm(file, { force: true })` are one file.
 * - `rmdir`, `rename`, `cp`, `copyFile` — every reference: a call, a value use
 *   (`names.map(fs.renameSync)`, `fs['renameSync']`), `.call` / `.apply` / `.bind`, a
 *   re-export (`export { renameSync } from 'node:fs'`). A file rename goes through
 *   `renameFileAtomic`, which owns the Windows retry.
 * - `reexport` — `export * from 'node:fs'`, which hands every banned function on.
 *
 * `unlink` is allowed: removing one file is not a tree change.
 *
 * Exempt: test files, and the entries of `exemptFiles`. An entry ending in `/` is a
 * DIRECTORY (anchored at a path-segment boundary: the primitive's directory, the test
 * infrastructure that lives in `src`); any other entry is one file. A bare name (`x.ts`
 * or `tree-change/`) is reported as unanchored, because it would exempt that name in
 * every package. No default exemption ships, so a consumer declares its own.
 */

const {
  EXEMPT_FILES_SCHEMA,
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createExemptDirectoryMatcher,
  createExemptPathMatcher,
  isTestFile,
  normalizeForMatch,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/** `fs` function name -> the messageId that reports it. `rm` is judged by its options. */
const MESSAGE_FOR = new Map([
  ['rm', 'recursiveRm'],
  ['rmSync', 'recursiveRm'],
  ['rmdir', 'rmdir'],
  ['rmdirSync', 'rmdir'],
  ['rename', 'rename'],
  ['renameSync', 'rename'],
  ['cp', 'cp'],
  ['cpSync', 'cp'],
  ['copyFile', 'copyFile'],
  ['copyFileSync', 'copyFile'],
]);

const UNANCHORED_EXEMPT_DIRECTORY = 'unanchoredExemptDirectory';
const FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);
/** Wrappers that pass a value through unchanged. */
const TRANSPARENT_TYPES = new Set(['AwaitExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression']);

/** The string a property key or member property spells, or undefined when not static. */
function staticName(node, computed) {
  if (!computed) {
    return node.type === 'Identifier' ? node.name : undefined;
  }
  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

/** True when `node` is a string literal naming an fs module. */
function isFsModuleLiteral(node) {
  return node?.type === 'Literal' && FS_MODULES.has(node.value);
}

/**
 * True when the `rm` options (the call's arguments) are, or may be, recursive. Only an
 * object literal that provably does not turn recursion on is safe.
 */
function mayBeRecursive(args) {
  if (args.slice(0, 2).some((argument) => argument.type === 'SpreadElement')) {
    return true;
  }
  const options = args[1];
  if (options === undefined || FUNCTION_TYPES.has(options.type)) {
    return false;
  }
  if (options.type !== 'ObjectExpression') {
    return true;
  }
  return options.properties.some((property) => {
    if (property.type !== 'Property') {
      return true;
    }
    const key = staticName(property.key, property.computed);
    if (key === undefined) {
      return true;
    }
    return key === 'recursive' && !(property.value.type === 'Literal' && property.value.value === false);
  });
}

/** `require('fs')` or `import('fs')`: an expression whose value is an fs namespace (a promise, for import). */
function isDynamicFsSource(node) {
  if (node.type === 'ImportExpression') {
    return isFsModuleLiteral(node.source);
  }
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    isFsModuleLiteral(node.arguments[0])
  );
}

/** The directory entries of `exemptFiles` that name no parent: `tree-change/`. */
function bareDirectoryEntries(exemptFiles) {
  return exemptFiles.filter((entry) => {
    const normalized = normalizeForMatch(entry).replace(/^\/+/, '');
    return normalized.endsWith('/') && !normalized.slice(0, -1).includes('/');
  });
}

/** Match each exemption entry to the matcher its shape asks for. */
function createExemptMatcher(exemptFiles) {
  const normalized = exemptFiles.map((entry) => normalizeForMatch(entry));
  const isUnderDirectory = createExemptDirectoryMatcher(normalized.filter((entry) => entry.endsWith('/')));
  const isFile = createExemptPathMatcher(normalized.filter((entry) => !entry.endsWith('/')));
  return (filename) => isUnderDirectory(filename) || isFile(filename);
}

/**
 * Judges every use of the fs names in one file, through the scope manager.
 *
 * `namespaces` holds the variables whose value is an fs namespace; `banned` maps a
 * variable to the fs function name it holds. Both grow as destructures and aliases are
 * followed, and each variable is judged once.
 */
class FsUseJudge {
  constructor(context) {
    this.context = context;
    this.sourceCode = context.sourceCode;
    this.namespaces = new Set();
    this.banned = new Map();
    this.pending = [];
  }

  /** Seed from the imports and the dynamic sources, then follow every binding to a fixed point. */
  run(programNode, dynamicSources) {
    for (const statement of programNode.body) {
      if (statement.type === 'ImportDeclaration' && isFsModuleLiteral(statement.source)) {
        for (const specifier of statement.specifiers) this.seedImport(specifier);
      }
    }
    for (const source of dynamicSources) this.useNamespace(source);
    while (this.pending.length > 0) {
      this.followReferences(this.pending.pop());
    }
  }

  seedImport(specifier) {
    const variable = this.sourceCode.getDeclaredVariables(specifier)[0];
    const imported = specifier.type === 'ImportSpecifier' ? (specifier.imported.name ?? specifier.imported.value) : undefined;
    if (imported === undefined || imported === 'promises') {
      this.markNamespace(variable);
    } else if (MESSAGE_FOR.has(imported)) {
      this.markBanned(variable, imported);
    }
  }

  followReferences(variable) {
    const isNamespace = this.namespaces.has(variable);
    for (const reference of variable.references.filter((candidate) => !candidate.init)) {
      if (isNamespace) {
        this.useNamespace(reference.identifier);
      } else {
        this.judgeBanned(reference.identifier, this.banned.get(variable));
      }
    }
  }

  markNamespace(variable) {
    if (variable && !this.namespaces.has(variable)) {
      this.namespaces.add(variable);
      this.pending.push(variable);
    }
  }

  markBanned(variable, name) {
    if (variable && !this.banned.has(variable)) {
      this.banned.set(variable, name);
      this.pending.push(variable);
    }
  }

  variableNamed(declaration, name) {
    return this.sourceCode.getDeclaredVariables(declaration).find((variable) => variable.name === name);
  }

  /** Bind the names a destructuring pattern takes from an fs namespace. */
  bindPattern(pattern, declaration) {
    if (pattern.type === 'Identifier') {
      this.markNamespace(this.variableNamed(declaration, pattern.name));
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) this.bindProperty(property, declaration);
    }
  }

  bindProperty(property, declaration) {
    if (property.type === 'RestElement') {
      this.bindPattern(property.argument, declaration);
      return;
    }
    const key = staticName(property.key, property.computed);
    const target = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
    if (key === 'promises') {
      this.bindPattern(target, declaration);
    } else if (MESSAGE_FOR.has(key) && target.type === 'Identifier') {
      this.markBanned(this.variableNamed(declaration, target.name), key);
    }
  }

  /** A banned function reached as `node`: report anything but a provably non-recursive `rm` call. */
  judgeBanned(node, name) {
    const parent = node.parent;
    const isCall = parent.type === 'CallExpression' && parent.callee === node;
    const isRm = MESSAGE_FOR.get(name) === 'recursiveRm';
    if (isCall && isRm && !mayBeRecursive(parent.arguments)) {
      return;
    }
    this.context.report({ node, messageId: MESSAGE_FOR.get(name), data: { name } });
  }

  /** `node` evaluates to an fs namespace: follow what its parent does with it. */
  useNamespace(node) {
    let current = node;
    while (TRANSPARENT_TYPES.has(current.parent?.type)) {
      current = current.parent;
    }
    const parent = current.parent;
    if (parent?.type === 'MemberExpression' && parent.object === current) {
      this.useMember(parent);
    } else if (parent?.type === 'VariableDeclarator' && parent.init === current) {
      this.bindPattern(parent.id, parent);
    }
  }

  useMember(member) {
    const name = staticName(member.property, member.computed);
    if (name === 'promises') {
      this.useNamespace(member);
    } else if (MESSAGE_FOR.has(name)) {
      this.judgeBanned(member, name);
    }
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban recursive rm, rmdir, rename, cp and copyFile outside the tree-change primitive: every tree change goes through one plan/apply protocol',
      category: 'Filesystem and process',
      bans: 'recursive `rm`/`rmSync`, `rmdir`, `rename`, `cp` and `copyFile` from `node:fs` / `node:fs/promises` (and their `Sync` forms), called or passed as values',
      useInstead: '`planTreeChanges()` / `applyTreePlan()`, `renameFileAtomic()`, `replaceFile()`, `copyTree()`, `withTempDir()` / `disposeTempDir()`',
      // Not in `recommended`: the remedy names this repo's own tree-change primitive,
      // which an adopter does not have. VAT enables it explicitly, naming the
      // primitive's directory and the test infrastructure that lives in `src`.
      recommended: false,
      recommendedSeverity: 'error',
    },
    fixable: null,
    schema: [EXEMPT_FILES_SCHEMA],
    messages: {
      recursiveRm:
        '{{name}} removes a tree, or may (its options are not a literal that rules recursion out). ' +
        'Plan the removal with planTreeChanges() / applyTreePlan(), or dispose a temp dir with withTempDir() / disposeTempDir(). ' +
        'Removing one file is fine: rm(file, { force: true }) or unlink().',
      rmdir: '{{name}} is a tree removal. Use planTreeChanges() / applyTreePlan() (op: remove) or disposeTempDir().',
      rename:
        '{{name}} is half a swap protocol. Replace a tree with planTreeChanges() / applyTreePlan(); ' +
        'rename a single file with renameFileAtomic(), which owns the Windows retry.',
      cp: '{{name}} copies a tree outside the primitive. Use copyTree(), or a replace change in planTreeChanges().',
      copyFile: '{{name}} copies a file outside the primitive. Use copyTree() or replaceFile().',
      reexport: 'Re-exporting every node:fs function hands on rm, rename, cp and copyFile. Export the names you need.',
      [UNANCHORED_EXEMPT_FILE]: UNANCHORED_EXEMPT_MESSAGE,
      [UNANCHORED_EXEMPT_DIRECTORY]:
        'exemptFiles entry "{{entry}}" is a bare directory name, so it exempts EVERY directory named ' +
        '"{{entry}}" in the repo — including ones added later. Give the repo-relative path instead ' +
        '(e.g. "packages/utils/src/{{entry}}").',
    },
  },

  create(context) {
    const filename = context.getFilename();
    const configured = context.options?.[0]?.exemptFiles;
    const exemptFiles = Array.isArray(configured) ? configured : [];
    const isExempt = createExemptMatcher(exemptFiles);

    /** Surface a malformed exemption list even for an exempt file: it may be exempt only BECAUSE of it. */
    const reportExemptions = (node) => {
      reportUnanchoredExemptEntries(context, node);
      for (const entry of bareDirectoryEntries(exemptFiles)) {
        context.report({ node, messageId: UNANCHORED_EXEMPT_DIRECTORY, data: { entry } });
      }
    };

    if (isExempt(filename)) {
      return { Program: reportExemptions };
    }
    if (isTestFile(filename)) {
      return {};
    }

    const dynamicSources = [];

    return {
      Program: reportExemptions,

      'CallExpression, ImportExpression'(node) {
        if (isDynamicFsSource(node)) {
          dynamicSources.push(node);
        }
      },

      ExportNamedDeclaration(node) {
        if (!isFsModuleLiteral(node.source)) {
          return;
        }
        for (const specifier of node.specifiers) {
          const name = specifier.local.name ?? specifier.local.value;
          if (MESSAGE_FOR.has(name)) {
            context.report({ node: specifier, messageId: MESSAGE_FOR.get(name), data: { name } });
          }
        }
      },

      ExportAllDeclaration(node) {
        if (isFsModuleLiteral(node.source)) {
          context.report({ node, messageId: 'reexport' });
        }
      },

      'Program:exit'(node) {
        new FsUseJudge(context).run(node, dynamicSources);
      },
    };
  },
};
