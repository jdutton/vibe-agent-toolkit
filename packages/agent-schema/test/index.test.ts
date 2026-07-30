import { describe, expect, it } from 'vitest';


import * as AgentSchema from '../src/index';
import type { AgentManifest, AgentMetadata, LLMConfig, Tool } from '../src/index';

/**
 * Compile-time control for the type exports.
 *
 * `bun run typecheck` fails if any of these stops being exported. There is
 * deliberately no `it('should export all types')` case: types are erased before
 * the test runner ever sees them, so a runtime assertion cannot check them. The
 * case that used to sit here asserted `expect(true).toBe(true)` and would have
 * stayed green through the deletion of every type in this list.
 */
type _ExportedTypes = [AgentManifest, AgentMetadata, LLMConfig, Tool];

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
