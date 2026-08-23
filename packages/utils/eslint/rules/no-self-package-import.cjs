/**
 * ESLint rule: no-self-package-import
 *
 * Disallow a file importing the package it already lives in **by that package's
 * own name**. Inside `packages/foo/src`, write `./types.js`, never
 * `@scope/foo`.
 *
 * @example
 * // ❌ BAD — packages/agent-runtime/src/session/file-session-store.ts
 * import type { SessionStore } from '@vibe-agent-toolkit/agent-runtime';
 *
 * // ✅ GOOD
 * import type { SessionStore } from './types.js';
 *
 * ## Why this is a build-breaker and not a style preference
 *
 * A self-import resolves out through `node_modules` to the package's OWN
 * `package.json`, whose `types`/`exports` point at `./dist/index.d.ts` — a file
 * the compiler is in the middle of producing. It appears to work only because of
 * a TypeScript courtesy: while `dist` IS the running project's output path,
 * `dist/index.d.ts` is recognised as this project's own declaration output and
 * the import is redirected back to `src`, so it resolves with no `dist/` on disk
 * at all.
 *
 * That courtesy is conditional, and every condition is one a build script may
 * legitimately change. Compile the package with `--outDir` pointed anywhere else
 * — a staging directory used to make emit atomic, for instance — and `dist` is
 * no longer this program's output, the redirect is gone, tsc looks for a literal
 * `dist/index.d.ts`, and a tree that has never been built has none:
 *
 *   error TS2307: Cannot find module '@scope/foo' or its corresponding type
 *                 declarations.
 *
 * Knock-on `TS2339`s follow wherever a local type extended one of the now
 * unresolved imports, which is what makes the failure read as a type bug in
 * code nobody touched.
 *
 * ## Why the compiler cannot be trusted to find these
 *
 * The failure is invisible on any machine that has built the package before:
 * a stale `dist/` satisfies the literal lookup, so the build passes — by
 * typechecking the package against its PREVIOUS build's declarations. Worse, in
 * a monorepo whose worktrees live inside the main checkout, module resolution
 * walks up past the worktree into the parent checkout's `node_modules` and
 * resolves against a DIFFERENT checkout's `dist/`. Both are green locally and
 * red in CI, which is the only place the tree is genuinely pristine.
 *
 * So a self-import is latent by construction: it costs nothing until the day a
 * build script changes `outDir`, and then it fails somewhere nobody can
 * reproduce. Lint is the only stage that sees it on the author's machine.
 *
 * ## `packageName` is required, and the rule reads no files to get it
 *
 * The obvious implementation walks up from the linted file to the nearest
 * `package.json` and reads its `name`. This rule deliberately does NOT: every
 * module on the `./eslint` subpath is plain data that requires nothing — not
 * `eslint`, not a third-party package, not even a Node builtin — which is what
 * lets the pack ship as a subpath of a runtime package, keeps `eslint` an
 * OPTIONAL peer dependency, and keeps the other subpaths resolving in a tree with
 * no ESLint installed. `test/eslint/subpath-purity.test.ts` enforces that as an
 * empty-set assertion. One `require('node:fs')` here would be the first crack in
 * it, for a convenience the config layer can supply for free.
 *
 * So the caller names the package, and the caller is a config file that already
 * runs in full Node and can read every manifest it likes. See the generated
 * per-package blocks in this repo's `eslint.config.js`.
 *
 * Scoping is the caller's job for the same reason: only files a package actually
 * COMPILES can break the build, and test and example trees commonly import their
 * own package by name ON PURPOSE, to exercise the public entry point exactly as a
 * consumer would.
 */

'use strict';

/**
 * Whether `specifier` names `packageName` itself or one of its subpaths.
 *
 * The subpath check is anchored on `/` so `@scope/foo-bar` is not read as a
 * subpath of `@scope/foo`.
 *
 * @param {string} specifier - The import specifier as written.
 * @param {string} packageName - The enclosing package's name.
 * @returns {boolean}
 */
function isSelfReference(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow importing the enclosing package by its own name; use a relative path so the import does not depend on the package's built `dist/`.",
      category: 'Build correctness',
      recommended: true,
    },
    messages: {
      useRelativeImport:
        "Do not import '{{specifier}}' — this file is already inside '{{packageName}}'. That resolves through the package's own `dist/`, which only works while `dist` is the running compiler's output path; change `outDir` (or build a tree that has never been built) and it fails with TS2307. Import the defining module by relative path instead.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          packageName: { type: 'string', minLength: 1 },
        },
        required: ['packageName'],
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    const { packageName } = context.options[0];

    /**
     * @param {{ type: string, value?: unknown } | null | undefined} source - A node in source position.
     */
    const check = (source) => {
      if (!source || source.type !== 'Literal') return;
      const specifier = source.value;
      if (typeof specifier !== 'string') return;
      if (!isSelfReference(specifier, packageName)) return;
      context.report({
        node: source,
        messageId: 'useRelativeImport',
        data: { specifier, packageName },
      });
    };

    return {
      // `import … from 'x'` and `import type … from 'x'`
      ImportDeclaration: (node) => check(node.source),
      // `export … from 'x'` and `export * from 'x'` — a barrel re-exporting
      // through its own package name is the same resolution, one step removed.
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      // `await import('x')`
      ImportExpression: (node) => check(node.source),
      // `import('x')` in TYPE position, which no other visitor above reaches.
      // The specifier hangs off `source`; typescript-eslint has called this
      // property `parameter` and `argument` in earlier majors, and reading the
      // wrong one costs nothing at lint time — the visitor simply never fires.
      // The `import() in TYPE position` case in `rules.test.ts` is what turns
      // that silence into a red test if a future parser renames it again.
      TSImportType: (node) => check(node.source),
      // `require('x')` in the `.cts`/`.cjs` files this pack also lints.
      CallExpression: (node) => {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        if (node.arguments.length !== 1) return;
        check(node.arguments[0]);
      },
    };
  },
};
