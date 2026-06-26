import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { normalizedTmpdir, safePath, type LinkAuthConfig, type Provider } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkValidator } from '../src/external-link-validator.js';

import { capturingFetch, countingFetch } from './auth-fetch-mocks.js';

const TEST_TOKEN = 'gh_test_token_abc';
const HOST = 'https://github.com/owner/repo/blob/main/file.md';
const REWRITTEN = 'https://api.github.com/repos/owner/repo/contents/file.md?ref=main';
const CACHE_FILE = 'external-links.json';
const BEARER_TOKEN_TEMPLATE = 'Bearer ${token}';

/**
 * Path-derived `existsSync` check — wraps the lint disable in one place. The
 * paths are tempDir-rooted, controlled by the test, not user input.
 */
function fsExists(p: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return existsSync(p);
}

function buildProvider(notFoundMeaning: 'ambiguous' | 'dead' = 'ambiguous'): Provider {
  return {
    match: { host: 'github.com' },
    rewrite: [
      {
        when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/blob/(?<ref>[^/]+)/(?<path>.+)$`,
        to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
      },
    ],
    auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE, Accept: 'application/vnd.github+json' } },
    token: [{ env: 'TEST_GH_TOKEN' }],
    check: { method: 'GET', aliveStatus: [200], notFoundMeaning },
  };
}

function configWithProvider(notFoundMeaning: 'ambiguous' | 'dead' = 'ambiguous'): LinkAuthConfig {
  return { providers: [buildProvider(notFoundMeaning)] };
}

function stubFetch(status: number, extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(null, { status, headers: extraHeaders })) as typeof fetch;
}

const ENV_WITH_TOKEN = { TEST_GH_TOKEN: TEST_TOKEN };
const ENV_EMPTY = {};

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'link-auth-validator-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ExternalLinkValidator — authenticated branch (verified)', () => {
  it('200 → status=ok, no code, statusCode=200', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(200),
    });
    const result = await validator.validateLink(HOST);
    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(result.code).toBeUndefined();
  });

  it('401 → status=error, code=LINK_AUTH_UNAUTHORIZED', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(401),
    });
    const result = await validator.validateLink(HOST);
    expect(result.status).toBe('error');
    expect(result.statusCode).toBe(401);
    expect(result.code).toBe('LINK_AUTH_UNAUTHORIZED');
  });

  it('403 → code=LINK_AUTH_FORBIDDEN', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(403),
    });
    const result = await validator.validateLink(HOST);
    expect(result.code).toBe('LINK_AUTH_FORBIDDEN');
  });

  it('404 with notFoundMeaning=ambiguous → code=LINK_AUTH_DEAD_OR_UNAUTHORIZED', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider('ambiguous'),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(404),
    });
    const result = await validator.validateLink(HOST);
    expect(result.code).toBe('LINK_AUTH_DEAD_OR_UNAUTHORIZED');
  });

  it('404 with notFoundMeaning=dead → code=LINK_AUTH_DEAD', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider('dead'),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(404),
    });
    const result = await validator.validateLink(HOST);
    expect(result.code).toBe('LINK_AUTH_DEAD');
  });

  it('500 (unclassified) → status=error, no code (consumer falls through to statusCode-mapping)', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(500),
    });
    const result = await validator.validateLink(HOST);
    expect(result.status).toBe('error');
    expect(result.statusCode).toBe(500);
    expect(result.code).toBeUndefined();
  });
});

describe('ExternalLinkValidator — authenticated branch (unverified, no token)', () => {
  it('returns LINK_AUTH_UNVERIFIED without calling fetch', async () => {
    const { fetchImpl, calls } = countingFetch();
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_EMPTY },
      fetchImpl,
    });
    const result = await validator.validateLink(HOST);
    expect(result.code).toBe('LINK_AUTH_UNVERIFIED');
    expect(result.status).toBe('error');
    expect(calls()).toBe(0);
  });
});

describe('ExternalLinkValidator — engine sends rewritten URL + auth headers', () => {
  it('passes the rewritten URL (not the original) to fetchImpl', async () => {
    const { fetchImpl, getCaptured } = capturingFetch((url) =>
      typeof url === 'string' ? url : url.toString(),
    );
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
    });
    await validator.validateLink(HOST);
    expect(getCaptured()).toBe(REWRITTEN);
  });

  it('passes the auth headers (with resolved token) to fetchImpl', async () => {
    const { fetchImpl, getCaptured } = capturingFetch(
      (_url, init) => (init?.headers ?? {}) as Record<string, string>,
    );
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
    });
    await validator.validateLink(HOST);
    const headers = getCaptured() ?? {};
    expect(headers['Authorization']).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers['Accept']).toBe('application/vnd.github+json');
  });
});

describe('ExternalLinkValidator — cache hit preserves LINK_AUTH_* code (regression: do not silently demote to EXTERNAL_URL_DEAD)', () => {
  it('two consecutive 404 fetches yield the same code on cache hit as on miss', async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider('ambiguous'),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
    });

    const first = await validator.validateLink(HOST);
    const second = await validator.validateLink(HOST);

    // Cache miss: classifier ran against the provider; code is set.
    expect(first.cached).toBe(false);
    expect(first.code).toBe('LINK_AUTH_DEAD_OR_UNAUTHORIZED');

    // Cache hit: classifier re-ran with the same provider, code preserved.
    expect(second.cached).toBe(true);
    expect(second.code).toBe('LINK_AUTH_DEAD_OR_UNAUTHORIZED');
    expect(second.statusCode).toBe(404);

    // Only one network call — the second result really came from cache.
    expect(fetchCount).toBe(1);
  });

  it('cache hit re-classifies under the current provider (notFoundMeaning change between runs)', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;

    // First run: notFoundMeaning='ambiguous' → cache-write LINK_AUTH_DEAD_OR_UNAUTHORIZED.
    const v1 = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider('ambiguous'),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
    });
    const ambiguous = await v1.validateLink(HOST);
    expect(ambiguous.code).toBe('LINK_AUTH_DEAD_OR_UNAUTHORIZED');

    // Second run: same cacheDir, but provider's notFoundMeaning flipped to 'dead'.
    // The cache hit must re-classify under the NEW provider, not return the
    // cached cassette's interpretation.
    const v2 = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider('dead'),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
    });
    const dead = await v2.validateLink(HOST);
    expect(dead.cached).toBe(true);
    expect(dead.code).toBe('LINK_AUTH_DEAD');
  });
});

describe('ExternalLinkValidator — auth cache scoping (#113 §6.3)', () => {
  it('cache key is the REWRITTEN URL, not the original', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(200),
      osUser: 'testuser',
    });
    await validator.validateLink(HOST);

    const cacheFile = safePath.join(tempDir, 'auth-testuser', CACHE_FILE);
    expect(fsExists(cacheFile)).toBe(true);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads its own write
    const cacheData = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
    const expectedKey = createHash('sha256').update(REWRITTEN).digest('hex');
    const originalKey = createHash('sha256').update(HOST).digest('hex');
    expect(Object.hasOwn(cacheData, expectedKey)).toBe(true);
    expect(Object.hasOwn(cacheData, originalKey)).toBe(false);
  });

  it('auth cache lives under cacheDir/auth-${osUser} (not the shared anonymous cache)', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(200),
      osUser: 'alice',
    });
    await validator.validateLink(HOST);

    // Auth cache file written under the user-scoped sub-directory.
    expect(fsExists(safePath.join(tempDir, 'auth-alice', CACHE_FILE))).toBe(true);
    // Shared anonymous cache file NOT touched (auth result didn't leak into it).
    expect(fsExists(safePath.join(tempDir, CACHE_FILE))).toBe(false);
  });

  it('two validators with different osUser do NOT share auth-cache state', async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const aliceValidator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
      osUser: 'alice',
    });
    const bobValidator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
      osUser: 'bob',
    });

    const aliceFirst = await aliceValidator.validateLink(HOST);
    const bobFirst = await bobValidator.validateLink(HOST);
    expect(aliceFirst.cached).toBe(false);
    expect(bobFirst.cached).toBe(false); // Bob does NOT see Alice's cache.
    expect(fetchCount).toBe(2); // Both ran the network call.

    // But Alice's second call hits Alice's own cache.
    const aliceSecond = await aliceValidator.validateLink(HOST);
    expect(aliceSecond.cached).toBe(true);
    expect(fetchCount).toBe(2);
  });

  // Table-driven sanitizer test: every pathological osUser must produce a
  // cache directory that lives strictly inside `tempDir`. The exact sanitized
  // form is an implementation detail; the security property is "no escape".
  const SANITIZER_INPUTS = [
    '..',
    '../escaped',
    '.',
    '/',
    String.raw`\..\..`,
    'a/../b',
    '',
    '...',
    '-..-',
  ];
  for (const badUser of SANITIZER_INPUTS) {
    it(`sanitizes path-traversal-shaped osUser ${JSON.stringify(badUser)} (stays inside cacheDir)`, async () => {
      const validator = new ExternalLinkValidator(tempDir, {
        linkAuthConfig: configWithProvider(),
        linkAuthDeps: { env: ENV_WITH_TOKEN },
        fetchImpl: stubFetch(200),
        osUser: badUser,
      });
      await validator.validateLink(HOST);
      // Whatever the sanitized name is, the resulting auth-* directory must
      // be a direct child of tempDir (no `..` escape, no slash-injected
      // grandchild path).
      const { readdirSync, statSync } = await import('node:fs');
      const entries = readdirSync(tempDir);
      const authDir = entries.find((n) => n.startsWith('auth-'));
      expect(authDir, `no auth-* dir for osUser=${JSON.stringify(badUser)}`).toBeDefined();
      if (authDir === undefined) return; // unreachable; satisfies the type guard
      // The auth dir name must not itself contain a path separator or `..`
      // (defense-in-depth — even if safePath.join cleaned, the persisted
      // directory name shouldn't carry traversal-shaped fragments).
      expect(authDir.includes('/')).toBe(false);
      expect(authDir.includes('\\')).toBe(false);
      expect(authDir.includes('..')).toBe(false);
      const full = safePath.join(tempDir, authDir);
      expect(statSync(full).isDirectory()).toBe(true);
    });
  }

  it('sanitizes path-traversal characters in osUser', async () => {
    // OS usernames are normally ASCII, but Windows can produce DOMAIN\user
    // forms. The cache directory derivation must not allow '..' or
    // separators to escape the cacheDir.
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(200),
      osUser: '../escaped',
    });
    await validator.validateLink(HOST);

    // Security property: cache must NOT be written outside tempDir, even
    // though osUser contains `..` and `/`.
    const escapedFile = safePath.join(tempDir, '..', 'escaped', CACHE_FILE);
    expect(fsExists(escapedFile)).toBe(false);

    // Some user-scoped subdirectory of tempDir exists — the exact sanitized
    // form is an implementation detail (slashes → `_`, `..` → `__`), so just
    // assert that the safe target landed inside tempDir.
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(tempDir);
    const authDir = entries.find((name) => name.startsWith('auth-'));
    expect(authDir).toBeDefined();
    expect(fsExists(safePath.join(tempDir, authDir as string, CACHE_FILE))).toBe(
      true,
    );
  });
});

describe('ExternalLinkValidator — runCommand memoization (#125 review)', () => {
  it('reuses a token-resolution command across N URLs from the same provider', async () => {
    // A provider configured with a command-source token. Validating multiple
    // URLs from the same host must run the command at most once per validator
    // instance — `gh auth token` spawns a subprocess; doing it per-URL is the
    // exact pessimization the review caught.
    let runCommandCalls = 0;
    const provider: Provider = {
      match: { host: 'github.com' },
      rewrite: [
        {
          when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/blob/(?<ref>[^/]+)/(?<path>.+)$`,
          to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
        },
      ],
      auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE } },
      token: [{ command: ['gh', 'auth', 'token'] }],
      check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'ambiguous' },
    };

    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: { providers: [provider] },
      linkAuthDeps: {
        env: {},
        runCommand: (argv) => {
          runCommandCalls++;
          return { success: true, stdout: `tok-${argv.join('-')}` };
        },
      },
      fetchImpl: stubFetch(200),
    });

    await validator.validateLink('https://github.com/owner/repo/blob/main/a.md');
    await validator.validateLink('https://github.com/owner/repo/blob/main/b.md');
    await validator.validateLink('https://github.com/owner/repo/blob/main/c.md');

    expect(runCommandCalls).toBe(1);
  });

  it('runs separate commands for distinct argv (different providers do not share)', async () => {
    const calls: string[][] = [];
    const providerA: Provider = {
      match: { host: 'a.example.com' },
      rewrite: [{ when: '^.+$', to: 'https://api.a.example.com' }],
      auth: { headers: { Authorization: BEARER_TOKEN_TEMPLATE } },
      token: [{ command: ['cmd-a'] }],
      check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'dead' },
    };
    const providerB: Provider = {
      ...providerA,
      match: { host: 'b.example.com' },
      rewrite: [{ when: '^.+$', to: 'https://api.b.example.com' }],
      token: [{ command: ['cmd-b'] }],
    };
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: { providers: [providerA, providerB] },
      linkAuthDeps: {
        env: {},
        runCommand: (argv) => {
          calls.push([...argv]);
          return { success: true, stdout: 'tok' };
        },
      },
      fetchImpl: stubFetch(200),
    });

    await validator.validateLink('https://a.example.com/path');
    await validator.validateLink('https://b.example.com/path');

    expect(calls).toEqual([['cmd-a'], ['cmd-b']]);
  });
});

describe('ExternalLinkValidator — unsupported host falls through', () => {
  it('a URL no provider claims uses the anonymous markdown-link-check path (no code set)', async () => {
    // Wire a config with a provider that only claims github.com; validate an unrelated host.
    // The unsupported branch falls through to the existing markdown-link-check path, which
    // we don't mock here — the test just confirms we DON'T crash and the auth fetchImpl
    // is not invoked.
    const { fetchImpl, calls } = countingFetch();
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
      timeout: 100, // Fast bail when markdown-link-check tries to reach the URL.
      retries: 0,
    });
    // Use a host no provider claims; the real markdown-link-check will try to fetch and
    // either error or return some status — either way, the auth fetchImpl must not fire.
    await validator
      .validateLink('https://this-host-not-claimed.example.invalid/')
      .catch(() => undefined);
    expect(calls()).toBe(0);
  });
});

// Shared helper for the "network-level failure" describe block: construct a
// validator whose only variable is the fetchImpl, run validateLink, return result.
async function validateWithThrowingFetch(fetchImpl: typeof fetch) {
  return new ExternalLinkValidator(tempDir, {
    linkAuthConfig: configWithProvider(),
    linkAuthDeps: { env: ENV_WITH_TOKEN },
    fetchImpl,
  }).validateLink(HOST);
}

describe('ExternalLinkValidator — network-level failure (catch block)', () => {
  it('fetchImpl throws Error → status=error, statusCode=0, cached=false, no code', async () => {
    const result = await validateWithThrowingFetch((async () => {
      throw new Error('ECONNREFUSED: connection refused');
    }) as typeof fetch);
    expect(result.status).toBe('error');
    expect(result.statusCode).toBe(0);
    expect(result.cached).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.error).toBe('ECONNREFUSED: connection refused');
  });

  it('fetchImpl rejects with null (falsy) → fallback message "Authenticated fetch failed"', async () => {
    const result = await validateWithThrowingFetch(
      (async () => Promise.reject(null)) as typeof fetch,
    );
    expect(result.status).toBe('error');
    expect(result.statusCode).toBe(0);
    expect(result.error).toBe('Authenticated fetch failed');
  });

  it('fetchImpl rejects with serializable plain object → JSON in error message', async () => {
    const result = await validateWithThrowingFetch(
      (async () => Promise.reject({ code: 'ETIMEDOUT', host: 'api.github.com' })) as typeof fetch,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('ETIMEDOUT');
  });

  it('fetchImpl rejects with empty object {} → "Unknown error" fallback', async () => {
    const result = await validateWithThrowingFetch(
      (async () => Promise.reject({})) as typeof fetch,
    );
    expect(result.status).toBe('error');
    expect(result.error).toBe('Unknown error');
  });
});

describe('ExternalLinkValidator — clearCache and getCacheStats', () => {
  it('getCacheStats returns combined totals from both caches', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(200),
      osUser: 'statsuser',
    });
    // Prime the auth cache with one validated URL.
    await validator.validateLink(HOST);
    const stats = await validator.getCacheStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(typeof stats.expired).toBe('number');
  });

  it('clearCache wipes both caches — next validateLink is a fresh fetch, not a hit', async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
      osUser: 'clearuser',
    });
    // First call — cache miss.
    const first = await validator.validateLink(HOST);
    expect(first.cached).toBe(false);
    expect(fetchCount).toBe(1);
    // Second call — cache hit.
    const second = await validator.validateLink(HOST);
    expect(second.cached).toBe(true);
    expect(fetchCount).toBe(1);
    // Clear, then re-validate — cache gone, must fetch again.
    await validator.clearCache();
    const third = await validator.validateLink(HOST);
    expect(third.cached).toBe(false);
    expect(fetchCount).toBe(2);
  });
});

describe('ExternalLinkValidator — resolveOsUser (no osUser option)', () => {
  it('omitting osUser does not throw — an auth-* directory is created under cacheDir', async () => {
    // When osUser is omitted the constructor calls resolveOsUser(), which reads
    // os.userInfo() or falls back to USER/USERNAME env. This verifies the
    // default path runs without error and produces the expected directory layout.
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl: stubFetch(200),
      // osUser intentionally omitted — exercises resolveOsUser()
    });
    await validator.validateLink(HOST);
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(tempDir);
    expect(entries.some((e) => e.startsWith('auth-'))).toBe(true);
  });
});
