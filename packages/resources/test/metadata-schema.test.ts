import { describe, it, expect } from 'vitest';

import { ResourceMetadataSchema } from '../src/schemas/resource-metadata.js';

const VALID_CONTENT_KEY = `markdown.${'a'.repeat(64)}`;

describe('ResourceMetadataSchema with content key', () => {
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
    contentKey: VALID_CONTENT_KEY,
    ...overrides,
  });

  it('should require contentKey field', () => {
    const metadataWithoutKey = createBaseMetadata();
    delete (metadataWithoutKey as { contentKey?: string }).contentKey;

    const result = ResourceMetadataSchema.safeParse(metadataWithoutKey);
    expect(result.success).toBe(false);
  });

  it('should accept a valid content key', () => {
    const result = ResourceMetadataSchema.safeParse(createBaseMetadata());
    expect(result.success).toBe(true);
  });

  it.each([
    ['a bare SHA-256 (the old checksum shape)', 'a'.repeat(64)],
    ['an unknown parser kind', `yaml.${'a'.repeat(64)}`],
    ['uppercase hex', `markdown.${'A'.repeat(64)}`],
  ])('should reject %s', (_label, contentKey) => {
    const result = ResourceMetadataSchema.safeParse(createBaseMetadata({ contentKey }));
    expect(result.success).toBe(false);
  });

  it('should reject the removed checksum field (strict)', () => {
    const result = ResourceMetadataSchema.safeParse(createBaseMetadata({ checksum: 'a'.repeat(64) }));
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

describe('ResourceMetadataSchema HTML fields', () => {
  const base = {
    id: 'x',
    filePath: '/abs/x.html',
    links: [],
    headings: [],
    sizeBytes: 1,
    estimatedTokenCount: 1,
    modifiedAt: new Date(),
    contentKey: `html.${'a'.repeat(64)}`,
  };

  it('accepts optional anchors and parseErrors', () => {
    const parsed = ResourceMetadataSchema.parse({
      ...base,
      anchors: ['intro'],
      parseErrors: [{ message: 'missing-end-tag', line: 3 }],
    });
    expect(parsed.anchors).toEqual(['intro']);
    expect(parsed.parseErrors?.[0]?.message).toBe('missing-end-tag');
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() => ResourceMetadataSchema.parse({ ...base, bogus: 1 })).toThrow();
  });
});
