/**
 * vendor-manifest.ts — per-file SHA-256 hash manifest for the vendored
 * skill-creator directory. Used by preflight to detect mutation or tampering.
 *
 * Two public entry points:
 *   regenerateVendoredManifest(vendorDir)  — rewrite vendored.manifest.json
 *   verifyVendoredManifest(vendorDir)      — returns false on any mismatch
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema (strict — VAT-produced output)
// ---------------------------------------------------------------------------

/** Maps forward-slash relative path → sha256 hex. */
export const VendoredManifestSchema = z
  .object({ files: z.record(z.string(), z.string()) })
  .strict();

export type VendoredManifest = z.infer<typeof VendoredManifestSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_FILENAME = 'vendored.manifest.json';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk `dir` recursively, collecting all regular files in deterministic
 * (sorted) order. Returns forward-slash paths relative to `baseDir`.
 */
function collectFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];

  const walk = (current: string): void => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- vendorDir is our own asset directory
    const entries = readdirSync(current).sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      const abs = safePath.join(current, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- vendorDir is our own asset directory
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else {
        const rel = toForwardSlash(safePath.relative(baseDir, abs));
        results.push(rel);
      }
    }
  };

  walk(dir);
  return results;
}

/** Compute SHA-256 hex of a single file's bytes. */
function hashFile(absPath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is derived from our own vendorDir walk
  const bytes = readFileSync(absPath);
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk `vendorDir`, hash every file (excluding the manifest itself), and
 * write `vendorDir/vendored.manifest.json` with a `{ files: Record<string,string> }`
 * shape.
 *
 * Deterministic: files are sorted lexicographically; keys are forward-slash
 * relative paths from `vendorDir`.
 */
export function regenerateVendoredManifest(vendorDir: string): void {
  const allFiles = collectFiles(vendorDir, vendorDir);
  // Exclude the manifest file itself so hashing is idempotent
  const filesToHash = allFiles.filter((rel) => rel !== MANIFEST_FILENAME);

  const files: Record<string, string> = {};
  for (const rel of filesToHash) {
    const abs = safePath.join(vendorDir, rel);
    files[rel] = hashFile(abs);
  }

  const manifest: VendoredManifest = { files };
  const manifestPath = safePath.join(vendorDir, MANIFEST_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath is derived from our own vendorDir
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Verify the integrity of `vendorDir` against its stored manifest.
 *
 * Returns `false` when:
 *   - `vendored.manifest.json` is absent or unparseable
 *   - Any listed file is missing on disk
 *   - Any listed file's current hash differs from the stored hash
 *
 * Extra files on disk not listed in the manifest are silently allowed.
 */
export function verifyVendoredManifest(vendorDir: string): boolean {
  const manifestPath = safePath.join(vendorDir, MANIFEST_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath is derived from our own vendorDir
  if (!existsSync(manifestPath)) {
    return false;
  }

  let manifest: VendoredManifest;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath is derived from our own vendorDir
    const raw = readFileSync(manifestPath, 'utf8');
    manifest = VendoredManifestSchema.parse(JSON.parse(raw));
  } catch {
    return false;
  }

  for (const [rel, expectedHash] of Object.entries(manifest.files)) {
    const abs = safePath.join(vendorDir, rel);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is derived from our own vendorDir + manifest-listed path
    if (!existsSync(abs)) {
      return false;
    }
    const actualHash = hashFile(abs);
    if (actualHash !== expectedHash) {
      return false;
    }
  }

  return true;
}
