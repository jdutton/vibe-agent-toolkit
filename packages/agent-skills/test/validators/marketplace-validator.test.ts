import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { validateMarketplace } from '../../src/validators/marketplace-validator.js';
import {
  assertSingleError,
  assertValidationSuccess,
  createTestMarketplace,
  setupTempDir,
} from '../test-helpers.js';

describe('validateMarketplace', () => {
  const { getTempDir } = setupTempDir('marketplace-validator-test-');

  const validMarketplaceData = {
    name: 'test-marketplace',
    owner: { name: 'Test Org' },
    plugins: [
      {
        name: 'test-plugin',
        source: './test-plugin',
      },
    ],
  };

  it('should validate a valid marketplace directory', async () => {
    const tempDir = getTempDir();
    const marketplacePath = createTestMarketplace(tempDir, validMarketplaceData);

    const result = await validateMarketplace(marketplacePath);

    assertValidationSuccess(result);
    expect(result.type).toBe('marketplace');
  });

  it('should return error when marketplace.json is missing', async () => {
    const tempDir = getTempDir();
    const missingPath = safePath.resolve(tempDir, 'missing-marketplace');

    const result = await validateMarketplace(missingPath);

    assertSingleError(result, 'MARKETPLACE_MISSING_MANIFEST');
  });

  it('should return error when marketplace.json has invalid JSON', async () => {
    const tempDir = getTempDir();
    const marketplacePath = createTestMarketplace(tempDir, validMarketplaceData);

    // Overwrite with invalid JSON
    const fs = await import('node:fs');
    fs.writeFileSync(
      safePath.join(marketplacePath, '.claude-plugin', 'marketplace.json'),
      '{ invalid json }',
    );

    const result = await validateMarketplace(marketplacePath);

    assertSingleError(result, 'MARKETPLACE_INVALID_JSON');
  });

  it('should return error when marketplace.json fails schema validation', async () => {
    const tempDir = getTempDir();
    const marketplacePath = createTestMarketplace(tempDir, {
      name: 'test',
      // Missing required fields: owner, plugins
    });

    const result = await validateMarketplace(marketplacePath);

    expect(result.status).toBe('error');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(
      result.issues.every((issue) => issue.code === 'MARKETPLACE_INVALID_SCHEMA'),
    ).toBe(true);
  });

  it('should return success with metadata for valid marketplace', async () => {
    const tempDir = getTempDir();
    const marketplacePath = createTestMarketplace(tempDir, {
      ...validMarketplaceData,
      description: 'A test marketplace',
      version: '1.0.0',
    });

    const result = await validateMarketplace(marketplacePath);

    assertValidationSuccess(result);
    expect(result.metadata?.name).toBe('test-marketplace');
    expect(result.metadata?.description).toBe('A test marketplace');
    expect(result.metadata?.version).toBe('1.0.0');
  });
});
