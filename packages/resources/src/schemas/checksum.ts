import { z } from 'zod';

/**
 * SHA-256 checksum - 64 lowercase hexadecimal characters
 * @example "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 */
export const SHA256Schema = z
  .string()
  .length(64, 'SHA-256 hash must be exactly 64 characters')
  .regex(/^[a-f0-9]{64}$/, 'SHA-256 hash must contain only lowercase hexadecimal characters')
  .brand('SHA256');

export type SHA256 = z.infer<typeof SHA256Schema>;
