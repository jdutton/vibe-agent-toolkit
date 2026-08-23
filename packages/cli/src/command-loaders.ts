/**
 * Every top-level command, behind a loader.
 *
 * ## Why the factories are not called at module scope
 *
 * Each one transitively pulls `@vibe-agent-toolkit/resources` (~1.6s of module
 * load on Windows, dominated by the markdown toolchain), so importing all
 * fifteen made every invocation — `vat --version` included — pay for the whole
 * CLI surface. Only the command named on the command line is loaded.
 *
 * ## Why this is its own module and not part of `bin.ts`
 *
 * `bin.ts` is the executable: importing it PARSES ARGV AND RUNS A COMMAND. So
 * nothing can read the loader table from there. `vat doctor` needs to, in order
 * to answer "is this install complete?" — see `checkCommandModules`. Keep this
 * module's own imports to `commander` and dynamic `import()` only; a static
 * import added here is paid by every `vat` invocation again.
 */

import type { Command } from 'commander';

/**
 * Command name → a loader that imports its module and builds the command.
 *
 * Insertion order is the order commands appear in `--help`; audit is common, so
 * it is first.
 *
 * ⚠️ Look membership up with `Object.hasOwn`, never `in` and never a bare
 * index. This is an object literal, so its prototype is `Object.prototype` and
 * both of those see through to it: `vat toString` resolved to
 * `Object.prototype.toString` — truthy, and callable — which got invoked and
 * handed to `addCommand()`, crashing with an internal commander error where
 * every other unrecognised verb prints "unknown command". Pinned by
 * `test/integration/cli-basics.integration.test.ts`.
 */
export const COMMAND_LOADERS: Record<string, () => Promise<Command>> = {
  audit: async () => (await import('./commands/audit.js')).createAuditCommand(),
  corpus: async () => (await import('./commands/corpus/index.js')).createCorpusCommand(),
  inventory: async () => (await import('./commands/inventory.js')).createInventoryCommand(),
  resources: async () => (await import('./commands/resources/index.js')).createResourcesCommand(),
  rag: async () => (await import('./commands/rag/index.js')).createRagCommand(),
  agent: async () => (await import('./commands/agent/index.js')).createAgentCommand(),
  mcp: async () => (await import('./commands/mcp/index.js')).createMCPCommand(),
  skills: async () => (await import('./commands/skills/index.js')).createSkillsCommand(),
  skill: async () => (await import('./commands/skill/index.js')).createSkillCommand(),
  claude: async () => (await import('./commands/claude/index.js')).createClaudeCommand(),
  cache: async () => (await import('./commands/cache/index.js')).createCacheCommand(),
  build: async () => (await import('./commands/build.js')).createBuildTopLevelCommand(),
  validate: async () => (await import('./commands/validate.js')).createValidateTopLevelCommand(),
  verify: async () => (await import('./commands/verify.js')).createVerifyTopLevelCommand(),
};
