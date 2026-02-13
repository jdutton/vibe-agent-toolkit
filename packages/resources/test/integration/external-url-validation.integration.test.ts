/* eslint-disable security/detect-non-literal-fs-filename */
// Test file - all file operations are in temp directories
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import { setupTempDirTestSuite } from '../test-helpers.js';

const TEST_EXTERNAL_URL = 'https://example.com/page';

/**
 * Create a test file with external link and return registry
 */
async function setupRegistryWithExternalLink(tempDir: string, url: string): Promise<ResourceRegistry> {
  const testFile = join(tempDir, 'test.md');
  await writeFile(testFile, `# Test\n\n[Link](${url})\n`);

  const registry = new ResourceRegistry({ baseDir: tempDir });
  await registry.addResource(testFile);
  return registry;
}

// Network-dependent tests: skip in CI where egress restrictions cause flaky failures
describe.skipIf(!!process.env.CI)('ResourceRegistry external URL validation', () => {
  const suite = setupTempDirTestSuite('registry-external-urls-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should collect external URLs when checkExternalUrls is true', async () => {
    const registry = await setupRegistryWithExternalLink(suite.tempDir, TEST_EXTERNAL_URL);

    // Validate with external URL checking enabled
    const result = await registry.validate({ checkExternalUrls: true });

    // Should have attempted to validate external URLs
    // Note: We cannot reliably test the validation result since it depends on network
    // We just verify the option triggers the validation path
    expect(result).toBeDefined();
    expect(result.totalResources).toBe(1);
    expect(result.totalLinks).toBe(1);
  });

  it('should skip external URLs when checkExternalUrls is false', async () => {
    const registry = await setupRegistryWithExternalLink(suite.tempDir, TEST_EXTERNAL_URL);

    // Validate without external URL checking
    const result = await registry.validate({ checkExternalUrls: false });

    // Should pass - external URLs not checked
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should handle noCache option', async () => {
    const registry = await setupRegistryWithExternalLink(suite.tempDir, TEST_EXTERNAL_URL);

    // Validate with noCache option
    const result = await registry.validate({ checkExternalUrls: true, noCache: true });

    // Should complete without errors (actual result depends on network)
    expect(result).toBeDefined();
    expect(result.totalResources).toBe(1);
  });
});
