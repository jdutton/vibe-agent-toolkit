/**
 * Per-entry content cache for the linkAuth content-fetch primitive (design
 * issue #113 §6.2 + §6.3).
 *
 * Layout: under `cacheDir/` each entry is two files keyed by `sha256(url).hex`:
 *   - `<hash>.json` — metadata (status, content-type, etag/last-modified,
 *                     fetchedAt, rewrittenUrl, schema version)
 *   - `<hash>.bin`  — raw response bytes, binary-clean
 *
 * The split lets one entry read load only what we need: metadata for the
 * TTL/version check, then the bytes only on a hit. A single-JSON layout would
 * have meant base64-encoding bytes (~33% bloat) and reparsing every entry on
 * every lookup. Two-file layout pays one extra `open()` per hit and scales
 * better as content size grows.
 *
 * **Cross-user isolation is the caller's job** (§6.3) — pass a cacheDir
 * already scoped to the OS user (e.g. `<cacheDir>/content/auth-<osUser>/`).
 * The cache class itself only knows about the directory it was given.
 *
 * **TTL** defaults to 30 minutes per §6.3. The content-fetch primitive's
 * `forceRefresh` option bypasses the cache; this class has no `clear()` —
 * stale entries fall out naturally on TTL expiry, and `forceRefresh` covers
 * "I authenticated as the wrong identity" per §6.3.
 *
 * **Fail-soft IO** per #125 review: ENOENT/EACCES/EROFS/corrupted-JSON all
 * degrade to a miss (for reads) or a no-op (for writes). A non-persisted
 * entry costs an extra fetch on the next run; an exception costs the whole
 * current run.
 *
 * **Strict metadata shape**: `set()` writes only declared `ContentMetadata`
 * fields, even if the caller passes structurally-typed extras. The fetch
 * primitive is the authority on what may be persisted, and a cache that
 * silently passes through unknown fields could leak a token value if the
 * primitive (or future code) ever forgot.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Cache schema version. Bump when `ContentMetadata` or the on-disk layout
 * changes. Entries with a missing or non-matching version are read as a miss
 * (rather than misparsed) — the next fetch repopulates them under the new
 * schema.
 */
const CACHE_VERSION = 1;

const DEFAULT_TTL_MINUTES = 30;

export interface ContentMetadata {
  readonly status: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** Epoch ms when the response was received (used for TTL evaluation). */
  readonly fetchedAt: number;
  /** The rewritten URL the bytes were fetched from (§6.3 cache-key discipline). */
  readonly rewrittenUrl: string;
}

export interface ContentCacheEntry {
  readonly bytes: Uint8Array;
  readonly metadata: ContentMetadata;
}

interface StoredMetadata extends ContentMetadata {
  readonly version: number;
}

export class ContentCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;

  /**
   * @param cacheDir - Already-OS-user-scoped directory for entries. Caller
   *   builds this; the class does not know about users or scoping.
   * @param ttlMinutes - Time-to-live in minutes. Defaults to the §6.3 30-min
   *   "session" window.
   */
  constructor(cacheDir: string, ttlMinutes: number = DEFAULT_TTL_MINUTES) {
    this.cacheDir = cacheDir;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  async get(url: string): Promise<ContentCacheEntry | null> {
    const key = this.keyFor(url);
    const jsonPath = safePath.join(this.cacheDir, `${key}.json`);
    const binPath = safePath.join(this.cacheDir, `${key}.bin`);

    const stored = await this.readMetadata(jsonPath);
    if (stored === null) return null;
    if (stored.version !== CACHE_VERSION) return null;
    if (this.isExpired(stored)) return null;

    const bytes = await this.readBytes(binPath);
    if (bytes === null) return null;

    // Strip the version field — that is an on-disk concern, not part of
    // the caller-facing `ContentMetadata` contract.
    return {
      bytes,
      metadata: pickMetadata(stored),
    };
  }

  async set(url: string, bytes: Uint8Array, metadata: ContentMetadata): Promise<void> {
    const key = this.keyFor(url);
    const jsonPath = safePath.join(this.cacheDir, `${key}.json`);
    const binPath = safePath.join(this.cacheDir, `${key}.bin`);

    // Whitelist exactly the declared ContentMetadata fields — defense in depth
    // against a caller that smuggles extra structurally-typed fields, so a
    // future regression in the primitive cannot accidentally persist a token
    // through this cache.
    const stored: StoredMetadata = { ...pickMetadata(metadata), version: CACHE_VERSION };

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is constructor parameter, controlled by caller
      await fs.mkdir(this.cacheDir, { recursive: true });
      // Write order matters: .bin first, then .json. The reader checks .json
      // first (version + TTL); a partially-written entry where .bin lands but
      // .json doesn't reads as a miss (no .json). The hazard we are avoiding
      // is the reverse — a fresh .json with a stale .bin from a prior set()
      // for the same URL would serve old bytes under new metadata. Writing
      // .json second guarantees that whenever .json reflects the new entry,
      // .bin already does too.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- binPath derived from cacheDir
      await fs.writeFile(binPath, Buffer.from(bytes));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- jsonPath derived from cacheDir
      await fs.writeFile(jsonPath, JSON.stringify(stored), 'utf-8');
    } catch {
      // Fail-soft per #125 review: a write IO failure (EACCES on the dir,
      // ENOSPC on the disk, EROFS on read-only mounts) becomes a no-op. The
      // current run still has the fresh bytes; only the disk persistence is
      // lost.
    }
  }

  private keyFor(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  private isExpired(stored: StoredMetadata): boolean {
    return Date.now() - stored.fetchedAt > this.ttlMs;
  }

  private async readMetadata(jsonPath: string): Promise<StoredMetadata | null> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- jsonPath derived from cacheDir
      const raw = await fs.readFile(jsonPath, 'utf-8');
      return JSON.parse(raw) as StoredMetadata;
    } catch {
      // ENOENT (never written), EACCES (perms revoked), SyntaxError
      // (corrupted JSON) — all degrade to a miss. The next fetch repopulates.
      return null;
    }
  }

  private async readBytes(binPath: string): Promise<Uint8Array | null> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- binPath derived from cacheDir
      const buf = await fs.readFile(binPath);
      // Return a fresh Uint8Array view that does not alias the Node Buffer's
      // underlying ArrayBuffer slab — callers may mutate or store the bytes.
      return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch {
      return null;
    }
  }
}

/**
 * Single source of truth for the on-disk metadata field list. Used in both
 * `set()` (whitelist before write — strips smuggled fields, including the
 * `version` field on round-trip) and `get()` (drop the `version` field before
 * returning to the caller). Centralizing the list means future §8 audits
 * only need to inspect one place.
 */
function pickMetadata(source: ContentMetadata): ContentMetadata {
  return {
    status: source.status,
    contentType: source.contentType,
    etag: source.etag,
    lastModified: source.lastModified,
    fetchedAt: source.fetchedAt,
    rewrittenUrl: source.rewrittenUrl,
  };
}
