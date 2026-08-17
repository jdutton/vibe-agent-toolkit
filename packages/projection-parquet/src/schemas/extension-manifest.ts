/**
 * Shape of the manifest that ships beside the captured DuckDB extension bytes.
 *
 * Every field is **recorded at build time from a real load**, never declared:
 * the repository host is the directory name a genuine download created, and the
 * core version and platform token come out of `pragma_version()` /
 * `pragma_platform()` in the process that did the loading. Validating the file
 * against this schema is how a hand-edited or half-written manifest becomes a
 * clean error instead of a probe path that silently points nowhere — which is
 * the one condition that hangs (see `probe-path.ts`).
 */

import { z } from 'zod';

/** Lowercase hex SHA-256, as `createHash('sha256').digest('hex')` produces. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One captured extension file. */
export const ExtensionManifestEntrySchema = z.object({
  /** Bare extension name, e.g. `parquet`. */
  name: z.string().min(1),
  /**
   * Path below the shipped asset directory — and, unchanged, below the seeded
   * home's `.duckdb/extensions`. The seeder mirrors this verbatim rather than
   * reconstructing it from the coordinates, so no code has to agree with
   * DuckDB about how the segments are spelled.
   */
  relativePath: z.string().min(1),
  /** Size in bytes of the captured file; the seeder's idempotency check. */
  bytes: z.number().int().positive(),
  /** SHA-256 of the captured bytes, checked before a copy is made. */
  sha256: z.string().regex(SHA256_HEX),
});

/** The manifest as a whole. */
export const DuckdbExtensionManifestSchema = z.object({
  /** Host segment of the extension URL, discovered from the captured tree. */
  repositoryHost: z.string().min(1),
  /** DuckDB **core** version segment, from `pragma_version().library_version`. */
  coreVersion: z.string().min(1),
  /** Wasm ABI token, from `pragma_platform()`. */
  platform: z.string().min(1),
  /** At least one entry — an empty manifest would seed nothing and read as fine. */
  extensions: z.array(ExtensionManifestEntrySchema).min(1),
});

export type ExtensionManifestEntry = z.infer<typeof ExtensionManifestEntrySchema>;
export type DuckdbExtensionManifest = z.infer<typeof DuckdbExtensionManifestSchema>;
