import { describe, it, expect } from 'vitest';


import { ResourceMetadataSchema } from '../src/schemas/resource-metadata.js';

describe('ResourceMetadataSchema with checksum', () => {
  const TEST_FILE_PATH = '/path/to/test.md';

  /**
   * Helper to create a valid base metadata object.
   * Tests can override specific fields as needed.
   */
  const createBaseMetadata = (overrides: Record<string, unknown> = {}) => ({
    id: 'test-doc',
    filePath: TEST_FILE_PATH,
    links: [],
    headings: [],
    sizeBytes: 100,
    estimatedTokenCount: 25,
    modifiedAt: new Date(),
    checksum: 'a'.repeat(64),
    ...overrides,
  });

  it('should require checksum field', () => {
    const metadataWithoutChecksum = createBaseMetadata();
    delete (metadataWithoutChecksum as { checksum?: string }).checksum;

    const result = ResourceMetadataSchema.safeParse(metadataWithoutChecksum);
    expect(result.success).toBe(false);
  });

  it('should accept valid checksum', () => {
    const result = ResourceMetadataSchema.safeParse(createBaseMetadata());
    expect(result.success).toBe(true);
  });

  it('should reject invalid checksum format', () => {
    const result = ResourceMetadataSchema.safeParse(
      createBaseMetadata({ checksum: 'not-a-valid-checksum' })
    );
    expect(result.success).toBe(false);
  });

  it('should accept resource with frontmatter', () => {
    const frontmatterData = { title: 'Test', tags: ['a', 'b'] };
    const result = ResourceMetadataSchema.safeParse(
      createBaseMetadata({ frontmatter: frontmatterData })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.frontmatter).toEqual(frontmatterData);
    }
  });

  it('should accept resource without frontmatter', () => {
    const result = ResourceMetadataSchema.safeParse(createBaseMetadata());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.frontmatter).toBeUndefined();
    }
  });
});
