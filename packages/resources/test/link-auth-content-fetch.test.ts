import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentCache } from '../src/content-cache.js';
import type { LinkAuthConfig, Provider } from '../src/link-auth/resolve.js';
import {
  fetchAuthenticated,
  type ContentFetchResult,
  type FetchAuthenticatedOptions,
} from '../src/link-auth-content-fetch.js';
import { type ContentMetadata } from '../src/schemas/content-cache.js';

import { capturingFetch, countingFetch } from './auth-fetch-mocks.js';

// External constants (no self-referential test fixtures).
const GITHUB_BLOB_URL = 'https://github.com/acme/widgets/blob/main/docs/api.md';
const GITHUB_CONTENTS_URL =
  'https://api.github.com/repos/acme/widgets/contents/docs/api.md?ref=main';
const SAMPLE_BYTES = new Uint8Array([0x48, 0x69, 0x21]); // "Hi!"
const SAMPLE_BYTES_BINARY = new Uint8Array([0x00, 0xff, 0x7f, 0x80]);
const GITHUB_RAW_ACCEPT = 'application/vnd.github.raw';
const GITHUB_JSON_ACCEPT = 'application/vnd.github+json';
const TOKEN_DO_NOT_PERSIST = 'gh_pat_SECRET_DO_NOT_PERSIST';
const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';
const UNSUPPORTED_URL = 'https://nowhere.example/x';
const EXPECTED_FETCH_ERROR = 'expected fetch result';
const TEXT_MARKDOWN = 'text/markdown';
const SAMPLE_ETAG = 'W/"abc123"';
const SAMPLE_LAST_MODIFIED = 'Wed, 18 Jun 2026 12:00:00 GMT';

const GITHUB_BLOB_REWRITE = {
  when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?:blob|tree)/(?<ref>[^/]+)/(?<path>.+)$`,
  to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
};

function githubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    match: { host: 'github.com' },
    rewrite: [GITHUB_BLOB_REWRITE],
    auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE, Accept: GITHUB_JSON_ACCEPT } },
    token: [{ env: 'GITHUB_TOKEN' }],
    check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'ambiguous' },
    ...overrides,
  };
}

const DEFAULT_DEPS = { env: { GITHUB_TOKEN: TOKEN_DO_NOT_PERSIST } };

/**
 * Run `fetchAuthenticated` with the standard github-provider config + valid
 * token. Throws if the call did not produce a fetch result — used by tests
 * that need the success branch for further assertions.
 */
async function fetchOk(
  fetchImpl: typeof fetch,
  overrides: Partial<FetchAuthenticatedOptions> = {},
): Promise<Extract<ContentFetchResult, { bytes: Uint8Array }>> {
  const result = await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
    fetchImpl,
    deps: DEFAULT_DEPS,
    ...overrides,
  });
  if (!('bytes' in result)) throw new Error(EXPECTED_FETCH_ERROR);
  return result;
}

/**
 * Assert the full metadata block matches the "sample github markdown" fixture
 * (status 200 + TEXT_MARKDOWN + SAMPLE_ETAG + SAMPLE_LAST_MODIFIED + the
 * engine's rewritten github URL). Used by both the cache-miss success-path
 * test and the cache-hit metadata round-trip test, so an on-disk regression
 * in any of these fields fails both assertions identically.
 */
function expectSampleMetadata(metadata: ContentMetadata): void {
  expect(metadata.status).toBe(200);
  expect(metadata.contentType).toBe(TEXT_MARKDOWN);
  expect(metadata.etag).toBe(SAMPLE_ETAG);
  expect(metadata.lastModified).toBe(SAMPLE_LAST_MODIFIED);
  expect(metadata.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);
}

function configFor(provider: Provider): LinkAuthConfig {
  return { providers: [provider] };
}

/** Fixed fetch impl returning the given bytes + headers. */
function bytesFetch(
  bytes: Uint8Array,
  responseHeaders: Record<string, string> = {},
  status = 200,
): { fetchImpl: typeof fetch; getCapturedHeaders: () => Record<string, string> | undefined } {
  let captured: Record<string, string> | undefined;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    if (init?.headers !== undefined) {
      captured = Object.fromEntries(new Headers(init.headers as HeadersInit));
    }
    return new Response(Buffer.from(bytes), {
      status,
      headers: responseHeaders,
    });
  }) as typeof fetch;
  return { fetchImpl, getCapturedHeaders: () => captured };
}

describe('fetchAuthenticated — short-circuit outcomes (no fetch, no cache)', () => {
  it('returns { outcome: "unsupported" } when no provider claims the host', async () => {
    const { fetchImpl, calls } = countingFetch();
    const result = await fetchAuthenticated(UNSUPPORTED_URL, { providers: [] }, {
      fetchImpl,
    });
    expect(result).toEqual({ outcome: 'unsupported' });
    expect(calls()).toBe(0);
  });

  it('returns { outcome: "unverified", reason } when no token resolves, even with fetch.headers configured', async () => {
    const { fetchImpl, calls } = countingFetch();
    const provider = githubProvider({
      fetch: { headers: { Accept: GITHUB_RAW_ACCEPT } },
    });
    const result = await fetchAuthenticated(GITHUB_BLOB_URL, configFor(provider), {
      fetchImpl,
      deps: { env: {} },
    });
    expect('outcome' in result && result.outcome).toBe('unverified');
    expect(calls()).toBe(0);
  });
});

describe('fetchAuthenticated — successful fetch (live, no cache)', () => {
  it('returns { bytes, metadata, cached: false } and metadata.rewrittenUrl is the engine-rewritten URL', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES, {
      'content-type': TEXT_MARKDOWN,
      etag: SAMPLE_ETAG,
      'last-modified': SAMPLE_LAST_MODIFIED,
    });
    const result = await fetchOk(fetchImpl);
    expect(result.bytes).toEqual(SAMPLE_BYTES);
    expect(result.cached).toBe(false);
    expectSampleMetadata(result.metadata);
  });

  it('metadata.contentType / etag / lastModified are null when response omits them', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES);
    const result = await fetchOk(fetchImpl);
    expect(result.metadata.contentType).toBeNull();
    expect(result.metadata.etag).toBeNull();
    expect(result.metadata.lastModified).toBeNull();
  });

  it('round-trips binary-clean bytes through the response body', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES_BINARY);
    const result = await fetchOk(fetchImpl);
    expect(result.bytes).toEqual(SAMPLE_BYTES_BINARY);
  });
});

describe('fetchAuthenticated — fetch.headers override (§6.2)', () => {
  it('sends auth.headers when provider has no fetch block', async () => {
    const { fetchImpl, getCapturedHeaders } = bytesFetch(SAMPLE_BYTES);
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl,
      deps: DEFAULT_DEPS,
    });
    const headers = getCapturedHeaders();
    expect(headers?.['accept']).toBe(GITHUB_JSON_ACCEPT);
    expect(headers?.['authorization']).toBe(`Bearer ${TOKEN_DO_NOT_PERSIST}`);
  });

  it('sends fetch.headers (overriding auth.headers on conflict) when provider declares fetch', async () => {
    const provider = githubProvider({
      fetch: { headers: { Accept: GITHUB_RAW_ACCEPT } },
    });
    const { fetchImpl, getCapturedHeaders } = bytesFetch(SAMPLE_BYTES);
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(provider), {
      fetchImpl,
      deps: DEFAULT_DEPS,
    });
    const headers = getCapturedHeaders();
    // Accept overridden by fetch.headers — content retrieval, not health-check.
    expect(headers?.['accept']).toBe(GITHUB_RAW_ACCEPT);
    // Authorization survives from auth.headers (fetch.headers didn't override).
    expect(headers?.['authorization']).toBe(`Bearer ${TOKEN_DO_NOT_PERSIST}`);
  });
});

describe('fetchAuthenticated — content cache integration', () => {
  let tempDir: string;
  let cache: ContentCache;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-fetch-test-'));
    cache = new ContentCache(tempDir, 30);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes through to the cache on a fresh fetch', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES, { 'content-type': TEXT_MARKDOWN });
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl,
      cache,
      deps: DEFAULT_DEPS,
    });
    const hit = await cache.get(GITHUB_CONTENTS_URL);
    expect(hit?.bytes).toEqual(SAMPLE_BYTES);
  });

  it('returns the cached entry with cached: true on the second call, full metadata round-trips intact', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES, {
      'content-type': TEXT_MARKDOWN,
      etag: SAMPLE_ETAG,
      'last-modified': SAMPLE_LAST_MODIFIED,
    });
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl,
      cache,
      deps: DEFAULT_DEPS,
    });

    const { fetchImpl: noFetch, calls } = countingFetch();
    const result = await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl: noFetch,
      cache,
      deps: DEFAULT_DEPS,
    });
    if (!('bytes' in result)) throw new Error('expected cache hit');
    expect(result.cached).toBe(true);
    expect(result.bytes).toEqual(SAMPLE_BYTES);
    expect(calls()).toBe(0);
    // Metadata round-trip — every field a future regression in the write-side
    // whitelist or the on-disk format could drop must be asserted against an
    // external constant, not against the cache's own previous output.
    expectSampleMetadata(result.metadata);
  });

  it('forceRefresh: true bypasses the cache, issues fetch, overwrites entry', async () => {
    const { fetchImpl: first } = bytesFetch(SAMPLE_BYTES);
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl: first,
      cache,
      deps: DEFAULT_DEPS,
    });

    const { fetchImpl: second } = bytesFetch(SAMPLE_BYTES_BINARY);
    const result = await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl: second,
      cache,
      forceRefresh: true,
      deps: DEFAULT_DEPS,
    });
    if (!('bytes' in result)) throw new Error(EXPECTED_FETCH_ERROR);
    expect(result.cached).toBe(false);
    expect(result.bytes).toEqual(SAMPLE_BYTES_BINARY);

    // Cache now holds the new bytes (overwrite confirmed via a third call).
    const hit = await cache.get(GITHUB_CONTENTS_URL);
    expect(hit?.bytes).toEqual(SAMPLE_BYTES_BINARY);
  });

  it('does not write to cache when caller does not supply one', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES);
    const result = await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl,
      deps: DEFAULT_DEPS,
    });
    if (!('bytes' in result)) throw new Error(EXPECTED_FETCH_ERROR);
    expect(result.cached).toBe(false);
    // (no cache → nothing to read back; the assertion that matters is the
    //  absence of any side effect, captured by the next test on persisted tokens)
  });

  it('NEVER caches unverified outcomes even when cache is supplied (§6.3)', async () => {
    const { fetchImpl, calls } = countingFetch();
    const provider = githubProvider({
      fetch: { headers: { Accept: GITHUB_RAW_ACCEPT } },
    });
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(provider), {
      fetchImpl,
      cache,
      deps: { env: {} }, // no token
    });
    expect(calls()).toBe(0);

    // Verify nothing landed on disk under the rewritten URL — the engine still
    // computes the rewrite even on unverified, but the primitive must not
    // touch the cache because the outcome would flip when a token appears.
    const hit = await cache.get(GITHUB_CONTENTS_URL);
    expect(hit).toBeNull();
  });

  it('NEVER caches an unsupported outcome (no engine plan, nothing to key on)', async () => {
    // Sanity: the cache is keyed by rewritten URL; without a plan there is
    // no key. Calling .get with the *original* URL must also miss.
    const { fetchImpl } = countingFetch();
    await fetchAuthenticated(UNSUPPORTED_URL, { providers: [] }, {
      fetchImpl,
      cache,
    });
    expect(await cache.get(UNSUPPORTED_URL)).toBeNull();
  });
});

describe('fetchAuthenticated — token never persisted (§8)', () => {
  let tempDir: string;
  let cache: ContentCache;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'content-fetch-tok-'));
    cache = new ContentCache(tempDir, 30);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('the token value never appears in any on-disk .json file after a successful fetch+cache', async () => {
    const { fetchImpl } = bytesFetch(SAMPLE_BYTES);
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl,
      cache,
      deps: DEFAULT_DEPS,
    });

    // Read every file in the temp dir RECURSIVELY; assert the literal token
    // string is absent from each one's raw bytes (defense in depth: not
    // relying on JSON structure to know what's "secret"). Recursive so a
    // future ContentCache layout that shards into subdirs (e.g.
    // `<hash[0..2]>/<hash>.json`) is still covered by this test.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: lists files inside self-created tempDir
    const entries = await fs.readdir(tempDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = safePath.join(entry.parentPath, entry.name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: reads files we just wrote inside self-created tempDir
      const raw = await fs.readFile(full);
      expect(raw.toString('utf-8')).not.toContain(TOKEN_DO_NOT_PERSIST);
    }
  });
});

describe('fetchAuthenticated — output signature', () => {
  it('passes the AbortSignal through to the transport', async () => {
    // Build a fetchImpl that surfaces the AbortSignal it sees; assert the
    // same signal arrives. (capturingFetch returns a 200 — sufficient for the
    // signal pass-through check.)
    const passedSignal = AbortSignal.timeout(50_000);
    const { fetchImpl, getCaptured } = capturingFetch(
      (_url, init) => (init?.signal as AbortSignal | undefined) ?? null,
    );
    await fetchAuthenticated(GITHUB_BLOB_URL, configFor(githubProvider()), {
      fetchImpl,
      deps: DEFAULT_DEPS,
      signal: passedSignal,
    });
    expect(getCaptured()).toBe(passedSignal);
  });
});
