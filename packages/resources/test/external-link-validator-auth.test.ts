import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

import { normalizedTmpdir, removeScratchDir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkValidator, isTransientRefusal } from '../src/external-link-validator.js';
import type { LinkAuthConfig, Provider } from '../src/link-auth/resolve.js';

import {
  capturingFetch,
  countingFetch,
  LEAK_CANARY,
  NUL,
  undiciHeaderValidatingFetch,
} from './auth-fetch-mocks.js';

const TEST_TOKEN = 'gh_test_token_abc';
const GITHUB_HOST = 'github.com';
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
    match: { host: GITHUB_HOST },
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
  await removeScratchDir(tempDir);
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

/**
 * A provider that cannot build a request for THIS url is not "no token": it
 * is reported under its own code, at error severity, and never cached.
 *
 * 🪤 It used to come back as `LINK_AUTH_UNVERIFIED` — the warning whose
 * registry remedy is "set to ignore if running without auth is intentional".
 * With that override in place a broken provider produced `status: success`
 * over links nothing had fetched.
 */
function providerFailingOnThisUrl(): LinkAuthConfig {
  const provider = buildProvider();
  return {
    providers: [
      {
        ...provider,
        rewrite: [
          {
            // `query` is optional and HOST has no query string, so the group
            // does not participate and `${query}` has nothing to read —
            // knowable only per URL, which is why it reaches the validator.
            when: String.raw`^https://github\.com/(?<path>[^?]+)(?<query>\?.*)?$`,
            to: 'https://api.github.com/${path}${query}',
          },
        ],
      },
    ],
  };
}

describe('ExternalLinkValidator — authenticated branch (provider failed on this link)', () => {
  it('returns LINK_AUTH_PROVIDER_ERROR without calling fetch, and does not cache it', async () => {
    const { fetchImpl, calls } = countingFetch();
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: providerFailingOnThisUrl(),
      linkAuthDeps: { env: ENV_WITH_TOKEN },
      fetchImpl,
      osUser: 'testuser',
    });
    const result = await validator.validateLink(HOST);
    expect(result.code).toBe('LINK_AUTH_PROVIDER_ERROR');
    expect(result.status).toBe('error');
    expect(result.error).toContain(GITHUB_HOST);
    expect(result.cached).toBe(false);
    expect(calls()).toBe(0);
    // Nothing written under either cache: the answer is about the provider,
    // not the URL, and flips the moment the config is fixed.
    expect(fsExists(safePath.join(tempDir, CACHE_FILE))).toBe(false);
    expect(fsExists(safePath.join(tempDir, 'auth-testuser', CACHE_FILE))).toBe(false);
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

/**
 * Run the same URL through one validator twice against a fixed response.
 *
 * Two runs is the whole point: the first is always a network call, and whether
 * the SECOND one is tells you — without reaching into the cache file — whether
 * the refusal was written down. A single validator is enough because its
 * in-memory map is the same cache the file backs.
 */
async function refuseTwice(
  cacheDir: string,
  status: number,
  headers: Record<string, string> = {},
): Promise<{ secondWasCached: boolean; calls: number }> {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(null, { status, headers });
  }) as typeof fetch;

  const validator = new ExternalLinkValidator(cacheDir, {
    linkAuthConfig: configWithProvider(),
    linkAuthDeps: { env: ENV_WITH_TOKEN },
    fetchImpl,
    osUser: 'throttled',
    // 429s carry a Retry-After in two of the rows below; without this the
    // suite would sleep for real.
    sleep: async () => {},
  });

  await validator.validateLink(HOST);
  const second = await validator.validateLink(HOST);
  return { secondWasCached: second.cached === true, calls };
}

describe('ExternalLinkValidator — a transient refusal is never cached', () => {
  // 🚨 The defect this pins: a rate-limited response was written into a cache
  // whose TTL is 24 HOURS, so a throttle that lasts a minute became a day of
  // "broken link" findings that no re-run could clear. The line drawn is
  // between a refusal the SERVER SAYS is temporary and one that is a standing
  // answer about this credential:
  //
  //   • 429 is transient by definition (RFC 6585 §4) — always.
  //   • 403 is transient ONLY when the response carries a rate-limit signal.
  //     GitHub documents both shapes it uses: a primary-limit refusal sets
  //     `x-ratelimit-remaining: 0`, a secondary-limit refusal sets
  //     `retry-after`. The RFC 9239-draft spelling `ratelimit-remaining` is
  //     accepted for hosts that use it.
  //   • A bare 403 is a DURABLE permission denial and stays cached — treating
  //     every 403 as transient would refetch every private link every run,
  //     which is the cost this cache exists to avoid.
  //
  // Signals are read from headers only. A body sniff would mean consuming a
  // stream on a path that does not otherwise need it, and matching on prose
  // that a vendor rewrites without notice — while the shapes GitHub actually
  // documents are headers.

  it.each([
    ['429 with no hint', 429, {}],
    ['429 carrying Retry-After', 429, { 'retry-after': '1' }],
    ['403 carrying Retry-After (GitHub secondary limit)', 403, { 'retry-after': '60' }],
    ['403 with x-ratelimit-remaining: 0 (GitHub primary limit)', 403, { 'x-ratelimit-remaining': '0' }],
    ['403 with ratelimit-remaining: 0 (RFC 9239 draft spelling)', 403, { 'ratelimit-remaining': '0' }],
    ['503 carrying Retry-After (a maintenance window)', 503, { 'retry-after': '300' }],
  ])('refetches after %s instead of answering from cache', async (_label, status, headers) => {
    const { secondWasCached } = await refuseTwice(tempDir, status, headers);

    expect(secondWasCached).toBe(false);
    // And nothing was left on disk for the next RUN to read either.
    expect(fsExists(safePath.join(tempDir, 'auth-throttled', CACHE_FILE))).toBe(false);
  });

  it.each([
    ['a bare 403 (permission denied)', 403, {}],
    ['a 403 whose quota is not exhausted', 403, { 'x-ratelimit-remaining': '4999' }],
    ['a 404', 404, {}],
    ['a bare 503 (no Retry-After — the server said nothing about when)', 503, {}],
  ])('still caches %s', async (_label, status, headers) => {
    const { secondWasCached, calls } = await refuseTwice(tempDir, status, headers);

    expect(secondWasCached).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('isTransientRefusal', () => {
  const headers = (init: Record<string, string>): Headers => new Headers(init);

  it.each([
    [429, {}],
    [429, { 'retry-after': '30' }],
    [403, { 'Retry-After': '30' }],
    [403, { 'X-RateLimit-Remaining': '0' }],
    [403, { 'RateLimit-Remaining': '0' }],
    [403, { 'x-rate-limit-remaining': '0' }],
    [503, { 'Retry-After': '300' }],
    [0, {}],
  ])('calls %i with %o transient', (status, init) => {
    expect(isTransientRefusal(status, headers(init))).toBe(true);
  });

  it.each([
    [403, {}],
    [403, { 'x-ratelimit-remaining': '17' }],
    [401, { 'retry-after': '30' }],
    [404, {}],
    [200, {}],
    [500, { 'retry-after': '30' }],
    [502, { 'retry-after': '30' }],
    [503, {}],
  ])('calls %i with %o durable', (status, init) => {
    expect(isTransientRefusal(status, headers(init))).toBe(false);
  });

  it('reads a 403 with no headers available as durable', () => {
    // The anonymous path has a status code and nothing else. Guessing
    // "transient" there would uncache every genuine permission denial.
    expect(isTransientRefusal(403, undefined)).toBe(false);
    expect(isTransientRefusal(429, undefined)).toBe(true);
  });

  it('reads "no response at all" as transient on both lanes', () => {
    // `statusCode: 0` is what a DNS/connect/TLS/timeout failure looks like
    // from either lane. The authenticated lane never reached `cache.set` on
    // that path by construction; the anonymous lane wrote it. One predicate,
    // so the two cannot disagree again.
    expect(isTransientRefusal(0, undefined)).toBe(true);
    expect(isTransientRefusal(0, headers({}))).toBe(true);
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

describe('ExternalLinkValidator — the token never reaches the emitted result (§8)', () => {
  // The end-to-end version of the transport-level redaction test: what
  // `vat resources validate` actually prints for a failing authenticated
  // request. Before the fix, undici's `Headers.append: "<value>" is an
  // invalid header value.` arrived here verbatim via `safeSerializeError`.
  // The canary, the NUL and the header-validating fetch are shared with
  // `link-auth-transport.test.ts` via `auth-fetch-mocks.ts`: this suite and
  // that one are the emit end and the transport end of the same §8 claim.

  it('a token with a NUL (or a multi-line credential-helper payload) is not emitted', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      // A `git credential fill` style helper emits several lines; `resolveToken`
      // only trims the ends, so the interior separator survives into the header.
      linkAuthDeps: { env: { TEST_GH_TOKEN: `${LEAK_CANARY}${NUL}` } },
      fetchImpl: undiciHeaderValidatingFetch,
      osUser: 'leakcheck',
    });

    const result = await validator.validateLink(HOST);

    expect(result.status).toBe('error');
    // The whole emitted record, not just `error` — nothing on it may carry it.
    expect(JSON.stringify(result)).not.toContain(LEAK_CANARY);
    expect(result.error).toBeDefined();
  });

  it('the cache file written for that run does not carry the token either', async () => {
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: configWithProvider(),
      linkAuthDeps: { env: { TEST_GH_TOKEN: `${LEAK_CANARY}${NUL}` } },
      fetchImpl: undiciHeaderValidatingFetch,
      osUser: 'leakcheck',
    });
    await validator.validateLink(HOST);

    const authDir = safePath.join(tempDir, 'auth-leakcheck');
    const cachePath = safePath.join(authDir, CACHE_FILE);
    if (fsExists(cachePath)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir-rooted path built by this test
      expect(readFileSync(cachePath, 'utf8')).not.toContain(LEAK_CANARY);
    }
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
