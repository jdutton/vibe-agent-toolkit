import type { KnipConfig } from 'knip';

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
        // onnxruntime loaded dynamically by rag-lancedb
        'onnxruntime-node',
        // Used by dev-tools scripts (invoked via tsx, not direct imports from root)
        'adm-zip',
        'semver',
      ],
    },

    'packages/*': {
      project: ['src/**/*.ts'],
    },

    // CLI: Commander.js wires commands from bin.ts, not index.ts
    'packages/cli': {
      entry: ['src/bin.ts'],
      ignoreDependencies: [
        // Installed as dep so vat-development-agents skill is available at runtime
        '@vibe-agent-toolkit/vat-development-agents',
      ],
    },

    // dev-tools: scripts are invoked via tsx from root, not from src/index.ts
    'packages/dev-tools': {
      entry: ['src/**/*.ts'],
    },

    // resource-compiler has CLI entry points beyond index.ts
    'packages/resource-compiler': {
      entry: ['src/cli/*.ts'],
    },

    // Runtime adapters: some deps provide types or are used in tests/examples
    'packages/runtime-vercel-ai-sdk': {
      ignoreDependencies: ['@ai-sdk/provider', '@ai-sdk/provider-utils'],
    },

    // vat-development-agents has standalone agent files + TS compiler plugin
    'packages/vat-development-agents': {
      entry: ['src/agents/*.ts'],
      ignoreDependencies: ['@vibe-agent-toolkit/agent-schema'],
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
