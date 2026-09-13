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
    /** Rule id → severity. Keys are namespaced: `@vibe-agent-toolkit/no-raw-node-path`. */
    rules: Record<string, 'error' | 'warn' | 'off'>;
  }

  interface Plugin {
    meta: { name: string };
    /** Rule name WITHOUT the namespace prefix, e.g. `no-raw-node-path`. */
    rules: Record<string, RuleModule>;
    configs: {
      /**
       * The cross-platform safety core: every rule whose `meta.docs.recommended`
       * is true, at the severity its `meta.docs.recommendedSeverity` declares.
       *
       * No count lives here on purpose. This comment once read "18 of the 22
       * rules, four are excluded" while the registry held 24 and the exclude
       * set six, and later "19 of the 27" — a number in prose is a claim the
       * manifest cannot check. The generated table in `README.md` carries the
       * live counts, and `test/eslint/rule-manifest.test.ts` asserts the
       * config against the directory rather than against a literal.
       *
       * Every rule that opts out states why beside its own `recommended: false`
       * in `rules/<name>.cjs`; all of them still ship in `rules` and are
       * enabled by naming them — which is what this repo's own
       * `eslint.config.js` does.
       */
      recommended: FlatConfig;
    };
  }
}

export = plugin;
