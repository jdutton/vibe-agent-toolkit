import { describe, it, expect } from 'vitest';

import { ResourceMetadataSchema } from '../src/schemas/resource-metadata.js';

describe('ResourceMetadataSchema with checksum', () => {
  const TEST_FILE_PATH = '/path/to/test.md';

  it('should require checksum field', () => {
    const metadataWithoutChecksum = {
      id: 'test-doc',
      filePath: TEST_FILE_PATH,
      links: [],
      headings: [],
      sizeBytes: 100,
      estimatedTokenCount: 25,
      modifiedAt: new Date(),
      // Missing: checksum
    };

    const result = ResourceMetadataSchema.safeParse(metadataWithoutChecksum);
    expect(result.success).toBe(false);
  });

  it('should accept valid checksum', () => {
    const validChecksum = 'a'.repeat(64);
    const metadataWithChecksum = {
      id: 'test-doc',
      filePath: TEST_FILE_PATH,
      links: [],
      headings: [],
      sizeBytes: 100,
      estimatedTokenCount: 25,
      modifiedAt: new Date(),
      checksum: validChecksum,
    };

    const result = ResourceMetadataSchema.safeParse(metadataWithChecksum);
    expect(result.success).toBe(true);
  });

  it('should reject invalid checksum format', () => {
    const invalidChecksum = 'not-a-valid-checksum';
    const metadataWithInvalidChecksum = {
      id: 'test-doc',
      filePath: TEST_FILE_PATH,
      links: [],
      headings: [],
      sizeBytes: 100,
      estimatedTokenCount: 25,
      modifiedAt: new Date(),
      checksum: invalidChecksum,
    };

    const result = ResourceMetadataSchema.safeParse(metadataWithInvalidChecksum);
    expect(result.success).toBe(false);
  });
});
