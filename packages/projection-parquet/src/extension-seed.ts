/**
 * Put the extension bytes this package ships where DuckDB will find them —
 * in a home directory **VAT owns**, never the user's.
 *
 * ## Why a VAT-owned home and not `~/.duckdb`
 *
 * Two measured reasons, either of which is sufficient:
 *
 * 1. `SET extension_directory` is **ignored** by duckdb-wasm — the glue reads
 *    `os.homedir()` directly — so `HOME` / `USERPROFILE` is the only lever that
 *    moves the cache, and the only safe way to pull that lever is on a child
 *    process rather than by mutating this one's environment.
 * 2. The glue never checks HTTP status before writing a downloaded body to the
 *    cache path, so one 404 or captive-portal page **permanently poisons**
 *    whichever cache it is pointed at. Pointing it at a VAT-owned directory
 *    means the worst case is our cache, recoverable with `vat cache clear`,
 *    instead of the user's.
 *
 * The home lives under the VAT cache **namespace** root (`parquet/`, already
 * reserved there beside `parse/`), so an upgrade of VAT — which is also an
 * upgrade of the pinned duckdb-wasm, and therefore possibly of the core-version
 * segment in the probe path — starts from a fresh directory for free.
 *
 * ## Seeding rules
 *
 * - **Verbatim mirror.** The manifest names a relative path; this module copies
 *   the shipped file to the identical relative path below the home's
 *   `.duckdb/extensions`. Nothing here parses or rebuilds the version segments.
 * - **Idempotent by size**, so the common case (already seeded) does no writing
 *   and no hashing.
 * - **Temp file + rename**, so a concurrent reader never sees a partial file —
 *   which would be indistinguishable from the poisoned-cache case.
 * - **Never throws.** A seed failure must degrade into a refused load with a
 *   readable reason, not a crashed CLI; the caller inspects {@link SeedOutcome}.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { vatCacheNamespaceRoot } from '@vibe-agent-toolkit/resources';
import { fileContentHash, mkdirSyncReal, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';

import { EXTENSION_CACHE_RELATIVE_DIR } from './probe-path.js';
import {
  type DuckdbExtensionManifest,
  DuckdbExtensionManifestSchema,
  type ExtensionManifestEntry,
} from './schemas/extension-manifest.js';

/** Directory, beside this module, holding the captured extension tree. */
export const SHIPPED_EXTENSION_DIRNAME = 'duckdb-extensions';

/** Manifest filename, beside this module. */
export const EXTENSION_MANIFEST_FILENAME = 'duckdb-extension-manifest.json';

/** Directory the build script writes the assets into, and this module reads them from. */
export function shippedAssetDir(): string {
  return safePath.join(resolveFromImportMeta(import.meta.url), '..');
}

/**
 * Read and validate the shipped manifest.
 *
 * @param assetDir - Override for tests; defaults to this module's own directory
 * @throws {Error} If the manifest is missing or does not match the schema —
 *   both mean the package was built wrong, and both must be loud
 */
export function loadShippedManifest(assetDir: string = shippedAssetDir()): DuckdbExtensionManifest {
  const manifestPath = safePath.join(assetDir, EXTENSION_MANIFEST_FILENAME);
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this module's own location
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `No DuckDB extension manifest at ${manifestPath}. The parquet extension bytes are ` +
        'captured during this package\'s build; run its build script before using the engine.',
    );
  }
  return DuckdbExtensionManifestSchema.parse(JSON.parse(raw) as unknown);
}

/**
 * The home directory VAT hands the engine child.
 *
 * A directory, not a file: the child's `HOME`/`USERPROFILE` points here and
 * DuckDB appends `.duckdb/extensions/...` to it itself.
 */
export function parquetEngineHome(): string {
  return safePath.join(vatCacheNamespaceRoot(), 'parquet');
}

/** What {@link seedExtensionHome} did, per extension. */
export interface SeedOutcome {
  /** Home directory that was seeded. */
  readonly home: string;
  /** Extensions copied in on this call. */
  readonly copied: readonly string[];
  /** Extensions already present at the right size. */
  readonly reused: readonly string[];
  /** Extensions that could not be seeded, with the reason. */
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

export interface SeedOptions {
  /** Home directory to seed. Defaults to {@link parquetEngineHome}. */
  readonly home?: string;
  /** Where the shipped assets live. Defaults to {@link shippedAssetDir}. */
  readonly assetDir?: string;
  /** Pre-loaded manifest, when the caller already read one. */
  readonly manifest?: DuckdbExtensionManifest;
}

/** Is a destination already the file the manifest describes? Size is the whole test — see the header. */
function alreadySeeded(destination: string, entry: ExtensionManifestEntry): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from the manifest, which is validated and ships with this package
    const stats = statSync(destination);
    return stats.isFile() && stats.size === entry.bytes;
  } catch {
    return false;
  }
}

/** Copy one shipped extension into place, atomically. Throws; the caller collects. */
function seedOne(assetDir: string, home: string, entry: ExtensionManifestEntry): void {
  const source = safePath.join(assetDir, SHIPPED_EXTENSION_DIRNAME, entry.relativePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this module's own location plus a validated manifest
  if (!existsSync(source)) {
    throw new Error(`shipped extension missing from the package at ${source}`);
  }
  const actual = fileContentHash(source);
  if (actual !== entry.sha256) {
    throw new Error(`shipped extension at ${source} hashes to ${actual}, manifest says ${entry.sha256}`);
  }

  const destination = safePath.join(home, EXTENSION_CACHE_RELATIVE_DIR, entry.relativePath);
  mkdirSyncReal(dirname(destination), { recursive: true });
  // A partially written file is indistinguishable from a poisoned cache entry,
  // so the bytes land under a private name and appear at the probe path whole.
  const staging = `${destination}.${process.pid}.tmp`;
  try {
    copyFileSync(source, staging);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths composed above from this module's location and a validated manifest
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * Ensure every shipped extension is present in `home`.
 *
 * @returns What happened per extension; never throws
 */
export function seedExtensionHome(options: SeedOptions = {}): SeedOutcome {
  const home = options.home ?? parquetEngineHome();
  const assetDir = options.assetDir ?? shippedAssetDir();
  const copied: string[] = [];
  const reused: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  let manifest: DuckdbExtensionManifest;
  try {
    manifest = options.manifest ?? loadShippedManifest(assetDir);
  } catch (error) {
    return { home, copied, reused, failed: [{ name: '*', reason: String(error) }] };
  }

  for (const entry of manifest.extensions) {
    const destination = safePath.join(home, EXTENSION_CACHE_RELATIVE_DIR, entry.relativePath);
    if (alreadySeeded(destination, entry)) {
      reused.push(entry.name);
      continue;
    }
    try {
      seedOne(assetDir, home, entry);
      copied.push(entry.name);
    } catch (error) {
      failed.push({ name: entry.name, reason: String(error) });
    }
  }

  return { home, copied, reused, failed };
}
