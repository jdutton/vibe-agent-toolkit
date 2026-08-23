import { describe, expect, it } from 'vitest';


import * as AgentSchema from '../src/index';

/**
 * There is deliberately no case here for the TYPE exports (`AgentManifest`,
 * `AgentMetadata`, `LLMConfig`, `Tool`). Types are erased before the runner sees
 * them, so no runtime assertion can check them — the case that used to sit here
 * asserted `expect(true).toBe(true)` and would have stayed green through the
 * deletion of every one of them.
 *
 * A compile-time tuple in THIS file would not work either, and saying otherwise
 * would just be the same false claim in a new form: `tsconfig.json` includes only
 * `src` and excludes every `.test.ts`, so `bun run typecheck` never reads this
 * file.
 *
 * The real control is downstream and already exists. Each type is a `z.infer` of
 * the schema asserted below, and the four are imported by typechecked `src/`
 * files in agent-config, agent-runtime, agent-skills and cli — so dropping an
 * export fails those packages' builds.
 */

describe('Package Exports', () => {
  it('should export AgentManifestSchema', () => {
    expect(AgentSchema.AgentManifestSchema).toBeDefined();
  });

  it('should export AgentMetadataSchema', () => {
    expect(AgentSchema.AgentMetadataSchema).toBeDefined();
  });

  it('should export LLMConfigSchema', () => {
    expect(AgentSchema.LLMConfigSchema).toBeDefined();
  });

  it('should export ToolSchema', () => {
    expect(AgentSchema.ToolSchema).toBeDefined();
  });
});
