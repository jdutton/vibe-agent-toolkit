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
       * The cross-platform safety core: 18 of the 22 rules, 15 `error` / 3 `warn`.
       * Four are excluded, for three reasons: `no-test-scoped-functions` and
       * `require-justified-skip` are positions on test style rather than
       * portability facts; `no-unsafe-root-join` keys on naming rather than taint;
       * and `no-raw-text-decode` names a decoding seam that only exists in the
       * consuming repo. All four still ship in `rules` and are enabled by naming
       * them.
       */
      recommended: FlatConfig;
    };
  }
}

export = plugin;
