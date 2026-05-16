import { describe, expect, it } from 'vitest';

import { CollectionValidationSchema } from '../src/schemas/project-config.js';

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
