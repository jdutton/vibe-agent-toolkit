import { describe, it, expect } from 'vitest';


import { SHA256Schema } from '../src/schemas/checksum.js';

describe('SHA256Schema', () => {
  it('should accept valid SHA-256 hash', () => {
    const validHash = 'a'.repeat(64);
    const result = SHA256Schema.safeParse(validHash);
    expect(result.success).toBe(true);
  });

  it('should reject hash with wrong length', () => {
    const shortHash = 'a'.repeat(63);
    const result = SHA256Schema.safeParse(shortHash);
    expect(result.success).toBe(false);
  });

  it('should reject hash with invalid characters', () => {
    const invalidHash = 'g'.repeat(64);
    const result = SHA256Schema.safeParse(invalidHash);
    expect(result.success).toBe(false);
  });

  it('should reject uppercase characters', () => {
    const uppercaseHash = 'A'.repeat(64);
    const result = SHA256Schema.safeParse(uppercaseHash);
    expect(result.success).toBe(false);
  });
});
