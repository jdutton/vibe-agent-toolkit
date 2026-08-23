import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentCache } from '../src/content-cache.js';
import { type ContentMetadata } from '../src/schemas/content-cache.js';

// External constants — used as inputs and as expected outputs. Tests must
// never assert `f(x) === f(y)`; comparisons always go against constants.
const EXAMPLE_URL = 'https://api.github.com/repos/acme/widgets/contents/docs/api.md?ref=main';
const SHAREPOINT_URL =
  'https://graph.microsoft.com/v1.0/shares/u!Zm9v/driveItem';
const SAMPLE_BYTES = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x01, 0x02, 0x03]);
const SAMPLE_BYTES_2 = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

// Build fresh metadata per test so `fetchedAt` reflects the (real or faked)
// current clock — a static fixture would be older than the TTL the moment it
// was authored and read as expired on every test run.
function makeMetadata(overrides: Partial<ContentMetadata> = {}): ContentMetadata {
  return {
    status: 200,
    contentType: 'text/markdown',
    etag: 'W/"abc123"',
    lastModified: 'Wed, 18 Jun 2026 12:00:00 GMT',
    fetchedAt: Date.now(),
    rewrittenUrl: EXAMPLE_URL,
    ...overrides,
  };
}

// chmod modes — same documentation pattern as external-link-cache.test.ts.
const MODE_NO_PERMS = 0o000;
const MODE_RO_OWNER = 0o500;
const MODE_RW_OWNER = 0o700;
const MODE_RW_FILE = 0o644;

function hashKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Hand-write a `.json` + `.bin` entry pair under `tempDir`, bypassing
 * ContentCache.set(). Used by the shape-validation / corrupted-JSON tests
 * that need to simulate on-disk content the class did not produce itself —
 * which is the only way to reach the read boundary's reject path, since
 * `set()` cannot write an entry `get()` would refuse.
 */
async function writeRawEntry(
  tempDir: string,
  url: string,
  jsonContent: string,
  bytes: Uint8Array,
): Promise<void> {
  const key = hashKey(url);
  const jsonPath = safePath.join(tempDir, `${key}.json`);
  const binPath = safePath.join(tempDir, `${key}.bin`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: write inside self-created tempDir
  await fs.writeFile(jsonPath, jsonContent);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: write inside self-created tempDir
  await fs.writeFile(binPath, Buffer.from(bytes));
}

describe('ContentCache — round-trip', () => {
  let tempDir: string;
  let cache: ContentCache;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-cache-test-'));
    cache = new ContentCache(tempDir, 30);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stores and retrieves bytes + metadata for the same URL', async () => {
    const metadata = makeMetadata();
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES, metadata);
    const result = await cache.get(EXAMPLE_URL);
    expect(result).not.toBeNull();
    expect(result?.bytes).toEqual(SAMPLE_BYTES);
    expect(result?.metadata).toEqual(metadata);
  });

  it('returns null for a URL never written', async () => {
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it('round-trips binary-clean bytes (no UTF-8 mangling on 0x00 / 0xFF)', async () => {
    const binary = new Uint8Array(256);
    for (let i = 0; i < 256; i++) binary[i] = i;
    await cache.set(EXAMPLE_URL, binary, makeMetadata());
    const result = await cache.get(EXAMPLE_URL);
    // Compare byte-for-byte against the externally-defined input, not against
    // a self-call of the cache.
    expect(result?.bytes).toEqual(binary);
  });

  it('isolates entries by URL (distinct hashes → distinct files)', async () => {
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
    await cache.set(
      SHAREPOINT_URL,
      SAMPLE_BYTES_2,
      makeMetadata({ rewrittenUrl: SHAREPOINT_URL }),
    );
    const r1 = await cache.get(EXAMPLE_URL);
    const r2 = await cache.get(SHAREPOINT_URL);
    expect(r1?.bytes).toEqual(SAMPLE_BYTES);
    expect(r2?.bytes).toEqual(SAMPLE_BYTES_2);
  });

  it('overwrites prior entry for the same URL', async () => {
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES_2, makeMetadata());
    const result = await cache.get(EXAMPLE_URL);
    expect(result?.bytes).toEqual(SAMPLE_BYTES_2);
  });
});

describe('ContentCache — TTL expiry (§6.3 30-min default)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-cache-ttl-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('at exactly the TTL the entry is still valid (boundary: `>` not `>=`)', async () => {
    vi.useFakeTimers();
    try {
      const cache = new ContentCache(tempDir, 30);
      await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
      // Exactly 30 min — boundary case. impl uses `>` so this is still valid.
      vi.advanceTimersByTime(30 * 60 * 1000);
      const result = await cache.get(EXAMPLE_URL);
      expect(result?.bytes).toEqual(SAMPLE_BYTES);
    } finally {
      vi.useRealTimers();
    }
  });

  it('one millisecond past the TTL the entry is evicted', async () => {
    vi.useFakeTimers();
    try {
      const cache = new ContentCache(tempDir, 30);
      await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
      // TTL + 1 ms — first instant the impl treats the entry as expired.
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      const result = await cache.get(EXAMPLE_URL);
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('well within the TTL the entry is unchanged', async () => {
    vi.useFakeTimers();
    try {
      const cache = new ContentCache(tempDir, 30);
      await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
      vi.advanceTimersByTime(29 * 60 * 1000);
      const result = await cache.get(EXAMPLE_URL);
      expect(result?.bytes).toEqual(SAMPLE_BYTES);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * These replace the `CACHE_VERSION` suite. The constant is gone, so what is
 * pinned here is the check that took its job: `StoredContentMetadataSchema`
 * at the read boundary. See `src/schemas/content-cache.ts` for why a schema
 * and not a namespace — this cache tenant deliberately sits outside the VAT
 * cache namespace, so nothing about an entry's address moves when VAT does.
 */
describe('ContentCache — shape validation at the read boundary', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-cache-shape-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('treats an entry carrying the removed `version` field as a miss', async () => {
    // Every entry written before the constant was removed looks exactly like
    // this. `.strict()` on the envelope makes them all cold in one step —
    // which IS the invalidation the constant existed to perform, done by the
    // check that replaced it rather than by anyone bumping a number.
    await writeRawEntry(
      tempDir,
      EXAMPLE_URL,
      JSON.stringify({ ...makeMetadata(), version: 1 }),
      SAMPLE_BYTES,
    );
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it('treats an entry missing `fetchedAt` as a miss, not as a fresh hit', async () => {
    // The hole the version gate could not see, and the reason this suite is
    // not just a rename. `Date.now() - undefined` is NaN and `NaN > ttlMs` is
    // false, so the TTL check waved this entry through and the caller got
    // `status: undefined` back as a successful fetch. A required, finite
    // `fetchedAt` is what makes the TTL arithmetic downstream trustworthy.
    const withoutFetchedAt: Record<string, unknown> = { ...makeMetadata() };
    delete withoutFetchedAt['fetchedAt'];
    await writeRawEntry(tempDir, EXAMPLE_URL, JSON.stringify(withoutFetchedAt), SAMPLE_BYTES);
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it('treats a wrong-typed field as a miss', async () => {
    await writeRawEntry(
      tempDir,
      EXAMPLE_URL,
      JSON.stringify({ ...makeMetadata(), status: 'ok' }),
      SAMPLE_BYTES,
    );
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it('treats a foreign JSON object filed under our key as a miss', async () => {
    // A `<sha256>.json` filename says which URL an entry is about and nothing
    // about its shape, so "well-formed JSON that is not one of ours" is a real
    // case, not a contrived one.
    await writeRawEntry(
      tempDir,
      EXAMPLE_URL,
      JSON.stringify({ url: EXAMPLE_URL, body: 'something else entirely' }),
      SAMPLE_BYTES,
    );
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it('still serves an entry it wrote itself (strict-on-read cannot self-reject)', async () => {
    // Negative control for the four misses above: `set()` strips to exactly
    // the declared keys, so `.strict()` on read can never turn our own entries
    // cold. Without this, the suite above would pass just as happily against a
    // `get()` hard-wired to return null.
    const cache = new ContentCache(tempDir, 30);
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
    expect((await cache.get(EXAMPLE_URL))?.bytes).toEqual(SAMPLE_BYTES);
  });
});

describe('ContentCache — fail-soft IO (per #125 review)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-cache-io-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('treats corrupted JSON as a miss', async () => {
    await writeRawEntry(tempDir, EXAMPLE_URL, 'not-valid-json{', SAMPLE_BYTES);
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'treats EACCES on .json file as a cache miss (fail-soft IO; POSIX-only)',
    async () => {
      const cache = new ContentCache(tempDir, 30);
      await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());
      const key = hashKey(EXAMPLE_URL);
      const jsonPath = safePath.join(tempDir, `${key}.json`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: revokes perms on self-created tempDir to simulate EACCES
      await fs.chmod(jsonPath, MODE_NO_PERMS);
      try {
        const fresh = new ContentCache(tempDir, 30);
        expect(await fresh.get(EXAMPLE_URL)).toBeNull();
      } finally {
        // eslint-disable-next-line security/detect-non-literal-fs-filename, sonarjs/file-permissions -- test-only: restore RW for cleanup
        await fs.chmod(jsonPath, MODE_RW_FILE);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'treats EACCES on cache directory as a no-op set (fail-soft IO; POSIX-only)',
    async () => {
      const cache = new ContentCache(tempDir, 30);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: read-only mode to simulate EACCES
      await fs.chmod(tempDir, MODE_RO_OWNER);
      try {
        await expect(cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata())).resolves.toBeUndefined();
      } finally {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: restore RW for cleanup
        await fs.chmod(tempDir, MODE_RW_OWNER);
      }
    },
  );
});

describe('ContentCache — security disciplines (§6.3, §8)', () => {
  let tempDir: string;
  let cache: ContentCache;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-cache-sec-'));
    cache = new ContentCache(tempDir, 30);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('never serializes fields outside ContentMetadata into the .json file', async () => {
    // Defense in depth: even if a caller smuggles an Authorization-like field
    // through structural typing, the cache writes only declared fields.
    const polluted = {
      ...makeMetadata(),
      Authorization: 'Bearer SECRET_TOKEN_DO_NOT_PERSIST',
      token: 'gh_pat_DO_NOT_PERSIST',
    } as ContentMetadata;
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES, polluted);

    const key = hashKey(EXAMPLE_URL);
    const jsonPath = safePath.join(tempDir, `${key}.json`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: reads file we just wrote inside self-created tempDir
    const raw = await fs.readFile(jsonPath, 'utf-8');
    expect(raw).not.toContain('SECRET_TOKEN_DO_NOT_PERSIST');
    expect(raw).not.toContain('gh_pat_DO_NOT_PERSIST');
    expect(raw).not.toContain('Authorization');
  });

  it('persists exactly the declared metadata keys, and nothing version-shaped', async () => {
    // An absence pin for the removed `CACHE_VERSION`, written against the
    // SHAPE rather than the symbol: `CACHE_VERSION_2` or a renamed
    // `entryRevision` field would sail through a check that only greps for the
    // old identifier, but neither can appear on disk without failing this.
    // Stated positively as well as negatively, so that quietly dropping a real
    // field (which `.strict()` on read would then reject) fails here too.
    await cache.set(EXAMPLE_URL, SAMPLE_BYTES, makeMetadata());

    const key = hashKey(EXAMPLE_URL);
    const jsonPath = safePath.join(tempDir, `${key}.json`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: reads file we just wrote inside self-created tempDir
    const parsed: unknown = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
    const keys = Object.keys(parsed as Record<string, unknown>).sort((a, b) => a.localeCompare(b));

    expect(keys).toStrictEqual([
      'contentType',
      'etag',
      'fetchedAt',
      'lastModified',
      'rewrittenUrl',
      'status',
    ]);
    expect(keys.filter((name) => /version|revision/iu.test(name))).toStrictEqual([]);
  });
});
