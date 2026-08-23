/**
 * Per-entry content cache for the linkAuth content-fetch primitive (design
 * issue #113 §6.2 + §6.3).
 *
 * Layout: under `cacheDir/` each entry is two files keyed by `sha256(url).hex`:
 *   - `<hash>.json` — metadata (status, content-type, etag/last-modified,
 *                     fetchedAt, rewrittenUrl)
 *   - `<hash>.bin`  — raw response bytes, binary-clean
 *
 * The split lets one entry read load only what we need: metadata for the
 * shape/TTL check, then the bytes only on a hit. A single-JSON layout would
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
 * **Every entry is validated against a schema on read, not versioned.** An
 * entry whose shape this build cannot account for — a missing field, a wrong
 * type, a key we have no field for — is a miss, not a plausible answer. This
 * replaced a hand-bumped `CACHE_VERSION` constant that never inspected a
 * single field; `schemas/content-cache.ts` records what that number bought,
 * what it missed, and why a namespace (the parse cache's answer) is
 * deliberately unavailable to this tenant.
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

import {
  ContentMetadataSchema,
  StoredContentMetadataSchema,
  type ContentMetadata,
} from './schemas/content-cache.js';

const DEFAULT_TTL_MINUTES = 30;

export interface ContentCacheEntry {
  readonly bytes: Uint8Array;
  readonly metadata: ContentMetadata;
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
    if (this.isExpired(stored)) return null;

    const bytes = await this.readBytes(binPath);
    if (bytes === null) return null;

    // No projection on the way out: `.strict()` already guarantees `stored`
    // carries exactly the declared `ContentMetadata` keys and nothing else.
    return { bytes, metadata: stored };
  }

  async set(url: string, bytes: Uint8Array, metadata: ContentMetadata): Promise<void> {
    const key = this.keyFor(url);
    const jsonPath = safePath.join(this.cacheDir, `${key}.json`);
    const binPath = safePath.join(this.cacheDir, `${key}.bin`);

    try {
      // Whitelist exactly the declared ContentMetadata fields — defense in
      // depth against a caller that smuggles extra structurally-typed fields,
      // so a future regression in the primitive cannot accidentally persist a
      // token through this cache. `ContentMetadataSchema` is non-strict, so an
      // extra key is dropped rather than refused; a *malformed declared* field
      // throws and lands in the fail-soft catch below, which is the outcome we
      // want — an entry the read boundary would reject is not worth writing.
      const stored = ContentMetadataSchema.parse(metadata);

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is constructor parameter, controlled by caller
      await fs.mkdir(this.cacheDir, { recursive: true });
      // Write order matters: .bin first, then .json. The reader checks .json
      // first (shape + TTL); a partially-written entry where .bin lands but
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
      // ENOSPC on the disk, EROFS on read-only mounts) — or metadata this
      // build cannot validate — becomes a no-op. The current run still has the
      // fresh bytes; only the disk persistence is lost.
    }
  }

  private keyFor(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  /**
   * TTL is evaluated only on metadata that already passed
   * {@link StoredContentMetadataSchema}, which is what makes this arithmetic
   * trustworthy: `fetchedAt` is a finite integer by the time it gets here.
   * Reading it off an unvalidated `JSON.parse` result made a missing
   * `fetchedAt` yield `NaN > ttlMs` — `false` — so the entry read as fresh.
   */
  private isExpired(stored: ContentMetadata): boolean {
    return Date.now() - stored.fetchedAt > this.ttlMs;
  }

  private async readMetadata(jsonPath: string): Promise<ContentMetadata | null> {
    try {
       
      // eslint-disable-next-line security/detect-non-literal-fs-filename, local/no-raw-text-decode -- reading back an entry THIS class wrote as UTF-8; the encoding is chosen here, not discovered
      const raw = await fs.readFile(jsonPath, 'utf-8');
      const validated = StoredContentMetadataSchema.safeParse(JSON.parse(raw));
      // A shape this build cannot account for is a miss, on the same footing
      // as corruption: we have no standing to interpret the other fields of a
      // file we did not write. See `schemas/content-cache.ts`.
      return validated.success ? validated.data : null;
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
