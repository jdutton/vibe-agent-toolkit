/**
 * Tests for schema path resolution in resources validate command
 *
 * Tests the algorithm that distinguishes between package paths and file paths,
 * ensuring users can reference schemas from installed npm packages OR local files.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';

// Test constants
const SCHEMAS_LOCAL_JSON = './schemas/local.json';

/**
 * Test helper: Creates schema files in test directory
 */
async function setupTestDir(testDir: string) {
  // Create directory structure
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is from suite helper
  await mkdir(join(testDir, 'schemas'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is from suite helper
  await mkdir(join(testDir, 'config'), { recursive: true });

  // Create test schema files
  const testSchema = { type: 'object', properties: { name: { type: 'string' } } };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is from suite helper
  await writeFile(join(testDir, 'schemas', 'local.json'), JSON.stringify(testSchema));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is from suite helper
  await writeFile(join(testDir, 'config', 'schema.json'), JSON.stringify(testSchema));
}

describe('Schema Path Resolution', () => {
  const suite = setupAsyncTempDirSuite('schema-path');
  let testDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    testDir = suite.getTempDir();
    await setupTestDir(testDir);
  });

  describe('File Path Resolution', () => {
    it('should resolve absolute paths', async () => {
      const schemaPath = join(testDir, 'schemas', 'local.json');

      // Dynamically import to avoid top-level await issues
      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);
      expect(resolved).toBe(schemaPath);
    });

    it('should resolve explicit relative paths starting with ./', async () => {
      const schemaPath = SCHEMAS_LOCAL_JSON;

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);
      expect(resolved).toBe(schemaPath);
    });

    it('should resolve explicit relative paths starting with ../', async () => {
      const schemaPath = '../config/schema.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);
      expect(resolved).toBe(schemaPath);
    });
  });

  describe('Package Path Resolution', () => {
    // NOTE: import.meta.resolve() is not available in Vitest environment
    // These tests work in real Node.js but not in Vitest's SSR transform
    // Manual testing required for package resolution
    it.skip('should resolve scoped package paths', async () => {
      // This package is installed in our monorepo
      const schemaPath = '@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      // Should resolve to an absolute path
      expect(resolved).toContain('agent-skills');
      expect(resolved).toContain('schemas');
      expect(resolved).toContain('skill-frontmatter.json');
      expect(resolved).not.toContain('@vibe-agent-toolkit');  // Package name not in resolved path
    });

    it('should throw clear error for non-existent scoped package', async () => {
      const schemaPath = '@non-existent/package/schemas/file.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      await expect(resolveSchemaPath(schemaPath)).rejects.toThrow(/Cannot resolve package path/);
      await expect(resolveSchemaPath(schemaPath)).rejects.toThrow(/@non-existent\/package/);
    });

    it('should throw clear error for scoped package with unexported subpath', async () => {
      // Package exists but this subpath is not exported
      const schemaPath = '@vibe-agent-toolkit/agent-skills/internal/private.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      await expect(resolveSchemaPath(schemaPath)).rejects.toThrow(/Cannot resolve package path/);
    });
  });

  describe('Bare Specifier Resolution', () => {
    it('should try package first for bare specifiers', async () => {
      // "vitest" is an installed package
      // If it exported this subpath, it would resolve
      // Since it doesn't, should fallback to file path
      const schemaPath = 'vitest/schemas/test.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      // Falls back to treating as file path (relative)
      expect(resolved).toBe(schemaPath);
    });

    it('should fallback to file path for non-existent packages', async () => {
      // No package called "schemas" is installed
      const schemaPath = 'schemas/local.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      // Falls back to treating as file path
      expect(resolved).toBe('schemas/local.json');
    });

    it.skip('should resolve known packages if subpath is exported', async () => {
      // Some packages export subpaths that can be resolved
      // Example: If a package exports "./schemas/file.json"
      // For testing, we use our own package which we know exports schemas

      const schemaPath = '@vibe-agent-toolkit/agent-skills/schemas/vat-skill-frontmatter.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      expect(resolved).toContain('vat-skill-frontmatter.json');
      expect(resolved).not.toContain('@vibe-agent-toolkit');
    });
  });

  describe('Ambiguity Scenarios', () => {
    it('should prefer package over file for matching bare specifier', async () => {
      // If user has both:
      // - ./lodash/schema.json (file)
      // - lodash package installed (if it exported schema.json)
      // Should try package first

      // For testing, we use a package we know exists
      const schemaPath = 'vitest/config';  // Bare specifier

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      // Will fallback to file since vitest doesn't export "config" as a subpath
      expect(resolved).toBe('vitest/config');
    });

    it('should use file when ./ prefix is explicit', async () => {
      // Even if package "schemas" existed, "./" forces file resolution
      const schemaPath = SCHEMAS_LOCAL_JSON;

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      // Should not try package resolution at all
      expect(resolved).toBe(SCHEMAS_LOCAL_JSON);
    });
  });

  describe('Error Messages', () => {
    it('should provide helpful error for scoped package not found', async () => {
      const schemaPath = '@my-org/my-package/schemas/file.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      await expect(resolveSchemaPath(schemaPath)).rejects.toThrow(/Cannot resolve package path/);
      await expect(resolveSchemaPath(schemaPath)).rejects.toThrow(/Package not installed/);
      await expect(resolveSchemaPath(schemaPath)).rejects.toThrow(/@my-org\/my-package/);
    });

    it('should mention possible causes in error message', async () => {
      const schemaPath = '@scope/package/file.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      try {
        await resolveSchemaPath(schemaPath);
        expect.fail('Should have thrown');
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        expect(message).toContain('Possible causes');
        expect(message).toContain('not installed');
        expect(message).toContain('not exported');
        expect(message).toContain('Typo');
      }
    });
  });

  describe('Real-World Usage Patterns', () => {
    it.skip('should handle config file pattern with package reference', async () => {
      // Common pattern in vibe-agent-toolkit.config.yaml
      const schemaPath = '@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      expect(resolved).toBeTruthy();
      expect(typeof resolved).toBe('string');
      expect(resolved.length).toBeGreaterThan(0);
    });

    it('should handle config file pattern with local file reference', async () => {
      const schemaPath = './schemas/custom-schema.json';

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      expect(resolved).toBe('./schemas/custom-schema.json');
    });

    it('should handle absolute paths from environment variables', async () => {
      const schemaPath = join(testDir, 'config', 'schema.json');

      const { resolveSchemaPath } = await import('../../src/commands/resources/validate.js');

      const resolved = await resolveSchemaPath(schemaPath);

      expect(resolved).toBe(schemaPath);
    });
  });
});
