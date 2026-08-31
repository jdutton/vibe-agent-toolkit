import type { KnipConfig } from 'knip';

/** Every package's TypeScript source lives here; several workspaces below name it. */
const SRC_TS = 'src/**/*.ts';

const config: KnipConfig = {
  // Only report dependency issues (not unused files/exports/types)
  include: ['dependencies', 'unlisted', 'unresolved'],

  // Global ignores: apply to all workspaces
  ignoreDependencies: [
    // @types/* are used for TypeScript compilation, not runtime imports
    '@types/.*',
    // tsx used for build scripts in package.json, not imported
    'tsx',
  ],

  // Vitest setup files and TS compiler plugins that knip can't resolve
  ignoreUnresolved: ['./vitest.setup.js'],

  workspaces: {
    '.': {
      ignoreDependencies: [
        // Validation tools invoked via CLI scripts, not imported
        'jscpd',
        'secretlint',
        '@secretlint/.*',
        // Root deps to fix transitive dependency resolution
        '@lancedb/lancedb',
        'apache-arrow',
        // Used by dev-tools scripts (invoked via tsx, not direct imports from root)
        'adm-zip',
        'semver',
      ],
    },

    'packages/*': {
      project: [SRC_TS],
    },

    // schema: scripts/ uses utils for JSON Schema generation
    'packages/schema': {
      entry: [SRC_TS, 'scripts/**/*.ts'],
    },

    // lab: the `vat-lab` binary is a second entry point alongside the barrel,
    // and it is the only thing that imports Commander. Its package.json `bin`
    // points at `dist/`, which knip cannot map back to source — so without this
    // the CLI's whole import graph is invisible and commander reads as unused.
    //
    // The io facet's counter is a THIRD entry point, and an invisible one: it is
    // loaded into the measured process via `NODE_OPTIONS=--require`, so nothing
    // in this repo ever imports it. Without it listed here knip reads a
    // load-bearing file as dead and deletes it on the next cleanup.
    'packages/lab': {
      entry: ['src/index.ts', 'src/bin/vat-lab.ts', 'src/facets/io/counter.cts'],
    },

    // CLI: Commander.js wires commands from bin.ts, not index.ts
    'packages/cli': {
      entry: ['src/bin.ts'],
      ignoreDependencies: [
        // Installed as dep so vat-development-agents skill is available at runtime
        '@vibe-agent-toolkit/vat-development-agents',
        // build script shells out to dev-tools/src/prepare-bin.ts via tsx (not a
        // static import) — declared so turbo's dependency graph knows cli#build
        // depends on dev-tools#build
        '@vibe-agent-toolkit/dev-tools',
        // The heavy RAG backends are opt-in optional peerDependencies loaded via
        // dynamic import() through src/utils/optional-backend.ts, so knip sees
        // them as "referenced optional peers". Intentional, and the same shape
        // already blessed for `openai` in packages/rag below: referencing one is
        // the whole point — the seam catches ERR_MODULE_NOT_FOUND and reports the
        // package to install. Declaring them as optionalDependencies instead is
        // what shipped ~300 MB to every adopter; see the note in
        // packages/cli/package.json and the guard in
        // packages/dev-tools/test/optional-backend-packaging.test.ts.
        '@vibe-agent-toolkit/rag',
        '@vibe-agent-toolkit/rag-lancedb',
      ],
    },

    // dev-tools: scripts are invoked via tsx from root, not from src/index.ts
    'packages/dev-tools': {
      entry: [SRC_TS],
    },

    // rag: OpenAI is an opt-in optional peerDependency loaded via dynamic
    // import() (bring-your-own-backend), so knip sees it as a "referenced
    // optional peer". Intentional — not auto-installed for consumers.
    'packages/rag': {
      ignoreDependencies: ['openai'],
    },

    // resource-compiler has CLI entry points beyond index.ts
    'packages/resource-compiler': {
      entry: ['src/cli/*.ts'],
    },

    // Runtime adapters: some deps provide types or are used in tests/examples
    'packages/runtime-vercel-ai-sdk': {
      ignoreDependencies: ['@ai-sdk/provider', '@ai-sdk/provider-utils'],
    },

    // utils: the `./eslint` subpath is hand-written CommonJS outside src/. Its
    // entry point and rules are `.cjs` and are only ever loaded by ESLint itself,
    // so they need naming explicitly or knip never walks them.
    'packages/utils': {
      entry: ['src/index.ts', 'eslint/index.cjs', 'eslint/rules/*.cjs'],
      project: [SRC_TS, 'eslint/*.cjs', 'eslint/rules/*.cjs'],
      // The `eslint` devDep IS used — `test/eslint/*` imports `RuleTester` and the
      // integration test drives `ESLint` — but `project` above covers no `test/**`,
      // so knip cannot see those imports and would report it unused. Ignored for
      // that reason, NOT because nothing needs it: deleting the devDep breaks the
      // rule suites, and this entry means knip will not warn you. (The rule modules
      // themselves genuinely never require('eslint') — that is what makes the peer
      // optional — but it is not why this line is here.)
      ignoreDependencies: ['eslint'],
    },

    // vat-development-agents has standalone agent files + TS compiler plugin
    'packages/vat-development-agents': {
      entry: ['src/agents/*.ts'],
      ignoreDependencies: [
        '@vibe-agent-toolkit/schema',
        // Invoked as `tspc` via `--compiler=tspc` passed to tsc-clean-build.ts — knip's
        // script-token scanner only matches a bin name as its own token, not inside a flag value.
        'ts-patch',
      ],
      // tsconfig includes resources/**/*.md which knip can't resolve as imports
      ignoreUnresolved: ['.*'],
    },

    // Example package: devDeps used in examples/ directory (outside knip src/ project scope)
    'packages/vat-example-cat-agents': {
      ignoreDependencies: [
        '@ai-sdk/openai',
        '@anthropic-ai/sdk',
        '@langchain/openai',
        '@vibe-agent-toolkit/runtime-.*',
        'ai',
        'openai',
      ],
    },

    // Umbrella package: re-exports CLI for global install
    'packages/vibe-agent-toolkit': {
      ignoreDependencies: [
        '@vibe-agent-toolkit/cli',
        // Installed so its postinstall hook deploys the vibe-agent-toolkit skill to ~/.claude/skills/
        '@vibe-agent-toolkit/vat-development-agents',
      ],
    },

  },
};

export default config;
