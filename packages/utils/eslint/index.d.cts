/**
 * Types for `@vibe-agent-toolkit/utils/eslint`.
 *
 * Hand-written, and deliberately structural rather than `import type { ESLint }
 * from 'eslint'`: `eslint` is an OPTIONAL peer dependency, so a consumer who took
 * this package for `safePath.join()` has no `eslint` types installed, and a
 * reference to them here would turn this entry into a type error for exactly the
 * people the optional peer exists to spare. The shapes below are the subset flat
 * config consumes, and are structurally assignable to `ESLint.Plugin`.
 *
 * `export =`, not `export default`: the implementation ends in
 * `module.exports = plugin`, and `export =` is the only declaration form that says
 * so. Consumers with `esModuleInterop` (the default for this repo's base config)
 * still write `import vat from '@vibe-agent-toolkit/utils/eslint'`.
 *
 * `.d.cts`, not `.d.ts`: under `moduleResolution: node16`/`nodenext` TypeScript
 * matches the declaration's extension to the module format of the file it
 * describes, and `index.cjs` is CommonJS inside a `"type": "module"` package.
 *
 * This file exists because `eslint.config.ts` is supported from ESLint 9.18.
 * Without it, an adopter writing one gets TS7016 on the import. It is NOT covered
 * by `bun run typecheck` (utils' tsconfig includes only `src/**‍/*.ts`), so the
 * packaged-artifact integration test compiles a consumer fixture against it
 * instead — see `test/integration/eslint-recommended-config.integration.test.ts`.
 */

declare const plugin: plugin.Plugin;

declare namespace plugin {
  /** A rule module, opaque here — adopters hand these to ESLint, never call them. */
  interface RuleModule {
    meta?: Record<string, unknown>;
    create: (context: unknown) => Record<string, unknown>;
  }

  /** A flat-config object, as returned by `configs.recommended`. */
  interface FlatConfig {
    name: string;
    plugins: Record<string, Plugin>;
    /** Rule id → severity. Keys are namespaced: `@vibe-agent-toolkit/no-path-join`. */
    rules: Record<string, 'error' | 'warn' | 'off'>;
  }

  interface Plugin {
    meta: { name: string };
    /** Rule name WITHOUT the namespace prefix, e.g. `no-path-join`. */
    rules: Record<string, RuleModule>;
    configs: {
      /**
       * The cross-platform safety core: 18 of the 25 rules, 15 `error` / 3 `warn`.
       *
       * Seven are excluded, for four reasons. `no-test-scoped-functions`,
       * `require-justified-skip` and `no-bare-symlink-in-tests` are positions on
       * TEST STYLE rather than portability facts. `no-unsafe-root-join` and
       * `no-process-exit-in-phase` key on NAMING rather than on the property they
       * care about (taint, and an orchestrated call site). `no-raw-text-decode`
       * names a decoding SEAM that only exists in the consuming repo. And
       * `no-self-package-import` REQUIRES an option this config cannot supply.
       *
       * All seven still ship in `rules` and are enabled by naming them — which is
       * what this repo's own `eslint.config.js` does. The count above is asserted
       * by `packages/utils/test/eslint/rules.test.ts`, so it cannot drift
       * unnoticed the way it did when this comment said "four".
       */
      recommended: FlatConfig;
    };
  }
}

export = plugin;
