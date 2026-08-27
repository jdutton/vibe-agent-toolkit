import { describe, expect, it } from 'vitest';

import { CollectionConfigSchema, CollectionValidationSchema } from '../src/schemas/project-config.js';

/** One include pattern, so each case below varies only the field under test. */
const INCLUDE = ['docs/**/*.md'];

describe('CollectionValidation.checkFrontmatterLinks', () => {
  it('accepts true', () => {
    expect(CollectionValidationSchema.parse({ checkFrontmatterLinks: true }))
      .toMatchObject({ checkFrontmatterLinks: true });
  });
  it('accepts false', () => {
    expect(CollectionValidationSchema.parse({ checkFrontmatterLinks: false }))
      .toMatchObject({ checkFrontmatterLinks: false });
  });
  it('accepts undefined (omitted)', () => {
    expect(CollectionValidationSchema.parse({}).checkFrontmatterLinks).toBeUndefined();
  });
  it('rejects non-boolean', () => {
    expect(() => CollectionValidationSchema.parse({ checkFrontmatterLinks: 'yes' })).toThrow();
  });
});

describe('CollectionConfig.mimeType', () => {
  it('accepts a declared MIME type', () => {
    expect(CollectionConfigSchema.parse({ include: INCLUDE, mimeType: 'text/markdown' }))
      .toMatchObject({ mimeType: 'text/markdown' });
  });

  it('accepts a type no built-in table knows — the vocabulary is the author\'s', () => {
    expect(CollectionConfigSchema.parse({ include: INCLUDE, mimeType: 'application/x-fraud-ingest' }))
      .toMatchObject({ mimeType: 'application/x-fraud-ingest' });
  });

  it('is undefined when omitted — a collection that declares nothing contributes nothing', () => {
    expect(CollectionConfigSchema.parse({ include: INCLUDE }).mimeType).toBeUndefined();
  });

  it('rejects a non-string', () => {
    expect(() => CollectionConfigSchema.parse({ include: INCLUDE, mimeType: 1 })).toThrow();
  });

  it('rejects the empty string, which is a typo rather than a type', () => {
    expect(() => CollectionConfigSchema.parse({ include: INCLUDE, mimeType: '' })).toThrow();
  });
});
