import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginSchema } from '../../src/schemas/plugin.js';

function loadPluginFixture(name: string): unknown {
  const fixturePath = resolve(__dirname, '../fixtures/plugins', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test helper loading fixtures from known directory
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}

/**
 * Helper function to test schema validation errors
 * Eliminates duplication in error validation tests
 */
function expectSchemaError(
  data: unknown,
  path: string,
  messageContains: string
): void {
  const result = PluginSchema.safeParse(data);
  expect(result.success).toBe(false);
  if (!result.success) {
    const error = result.error.issues.find(i => i.path[0] === path);
    expect(error).toBeDefined();
    expect(error?.message).toContain(messageContains);
  }
}

describe('PluginSchema', () => {
  it('should validate known-good plugin.json from superpowers', () => {
    const knownGood = loadPluginFixture('superpowers-plugin.json');
    const result = PluginSchema.safeParse(knownGood);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('superpowers');
      expect(result.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  describe('validation errors', () => {
    it('should reject plugin with missing name', () => {
      const invalid = {
        description: 'A plugin',
        version: '1.0.0',
      };

      expectSchemaError(invalid, 'name', 'Required');
    });

    it('should reject plugin with invalid version format', () => {
      const invalid = {
        name: 'test-plugin',
        description: 'A plugin',
        version: 'v1.0', // Invalid: must be x.y.z
      };

      expectSchemaError(invalid, 'version', 'semver');
    });

    it('should reject plugin with uppercase in name', () => {
      const invalid = {
        name: 'TestPlugin', // Invalid: must be lowercase
        description: 'A plugin',
        version: '1.0.0',
      };

      expectSchemaError(invalid, 'name', 'lowercase');
    });
  });
});
