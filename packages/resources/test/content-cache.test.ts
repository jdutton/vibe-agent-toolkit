import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentCache, type ContentMetadata } from '../src/content-cache.js';

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
 * ContentCache.set(). Used by the version-mismatch / corrupted-JSON tests
 * that need to simulate on-disk content the class did not produce itself.
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

describe('ContentCache — forward-compat version', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-cache-ver-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('treats a missing-version JSON file as a miss (legacy or hand-edited)', async () => {
    // Hand-write a JSON file without a version field — simulates a slice-3.x
    // entry being read by a slice-3.y reader that bumped the schema.
    await writeRawEntry(tempDir, EXAMPLE_URL, JSON.stringify({ ...makeMetadata() }), SAMPLE_BYTES);
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
  });

  it('treats a wrong-version JSON file as a miss', async () => {
    await writeRawEntry(
      tempDir,
      EXAMPLE_URL,
      JSON.stringify({ ...makeMetadata(), version: 999 }),
      SAMPLE_BYTES,
    );
    const cache = new ContentCache(tempDir, 30);
    expect(await cache.get(EXAMPLE_URL)).toBeNull();
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
});
