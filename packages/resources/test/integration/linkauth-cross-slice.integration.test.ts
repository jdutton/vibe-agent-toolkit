/**
 * Cross-slice integration test for issue #113.
 *
 * Verifies that slice 2's `ExternalLinkValidator` (health-check path) and
 * slice 3's `fetchAuthenticated` primitive (content-fetch path) work
 * together when given:
 *   - ONE adopter `vibe-agent-toolkit.config.yaml`-shaped config (bridged
 *     through `buildLinkAuthEngineConfig` exactly once)
 *   - ONE shared `wrapLinkAuthDepsWithMemo` deps object (so token
 *     resolution is amortized across both consumers)
 *   - The SAME URL fed to both APIs in the same run
 *
 * This is the test that would fail if (a) the engine output signature
 * regressed between slices, (b) the shared memo got broken by the slice-3
 * extract, (c) `cache.ttlMinutes` stopped flowing through the bridge, or
 * (d) the dual-header expansion changed the wire-level Accept value the
 * primitive sends.
 *
 * Lives at the integration tier (not unit) because it exercises real
 * wiring across the resources package's public surface, not pure logic.
 */

import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalLinkValidator } from '../../src/external-link-validator.js';
import {
  buildLinkAuthEngineConfig,
  ContentCache,
  fetchAuthenticated,
  wrapLinkAuthDepsWithMemo,
} from '../../src/index.js';
import type { LinkAuthProjectConfig } from '../../src/schemas/link-auth.js';

const GITHUB_BLOB_URL = 'https://github.com/acme/widgets/blob/main/docs/api.md';
const GITHUB_CONTENTS_URL =
  'https://api.github.com/repos/acme/widgets/contents/docs/api.md?ref=main';
const GITHUB_JSON_ACCEPT = 'application/vnd.github+json';
const GITHUB_RAW_ACCEPT = 'application/vnd.github.raw';
const SAMPLE_BODY = '# API Docs\n\nHello, integration test.\n';
const FAKE_TOKEN = 'fake-int-test-token';

/**
 * One adopter-shaped config, exactly as it would parse from
 * `vibe-agent-toolkit.config.yaml`. This is the same object both slices
 * consume — if a future change drifts the engine and adopter shapes apart,
 * this `as LinkAuthProjectConfig` cast plus the post-bridge consumer calls
 * will compile-break.
 */
const ADOPTER_CONFIG: LinkAuthProjectConfig = {
  cache: { ttlMinutes: 30 },
  providers: [
    {
      match: { host: 'github.com' },
      rewrite: [
        {
          when: String.raw`^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?:blob|tree)/(?<ref>[^/]+)/(?<path>.+)$`,
          to: 'https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}',
        },
      ],
      auth: {
        headers: { Authorization: 'Bearer ${token}', Accept: GITHUB_JSON_ACCEPT },
      },
      fetch: {
        headers: { Accept: GITHUB_RAW_ACCEPT },
      },
      token: [{ command: ['gh', 'auth', 'token'] }],
      check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'ambiguous' },
    },
  ],
};

interface CapturedRequest {
  url: string;
  accept: string | undefined;
  authorization: string | undefined;
}

function recordingFetch(): {
  fetchImpl: typeof fetch;
  requests: readonly CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const hdrs =
      init?.headers === undefined
        ? {}
        : Object.fromEntries(new Headers(init.headers as HeadersInit));
    requests.push({ url, accept: hdrs['accept'], authorization: hdrs['authorization'] });
    return new Response(Buffer.from(SAMPLE_BODY, 'utf-8'), {
      status: 200,
      headers: { 'content-type': 'text/markdown', etag: 'W/"int-test"' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('linkAuth — slice 2 validator + slice 3 primitive share config and memo (#113)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'linkauth-int-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('one adopter config bridged once feeds both slices coherently', async () => {
    const engineConfig = buildLinkAuthEngineConfig(ADOPTER_CONFIG);
    // Slice 3 propagation: `cache.ttlMinutes` must reach the engine config
    // so the content-fetch primitive can read it from the same source of
    // truth as the rest of the engine config.
    expect(engineConfig.cache?.ttlMinutes).toBe(30);
    // Slice 3 schema: `provider.fetch.headers` must survive the bridge so
    // the primitive's dual-expansion can pick it up.
    expect(engineConfig.providers[0]?.fetch?.headers['Accept']).toBe(GITHUB_RAW_ACCEPT);

    // Shared memo: one `gh auth token`-equivalent call across both slices.
    // The validator iterating N URLs and the primitive being invoked
    // afterwards together must run the resolver exactly once.
    const runCommand = vi.fn(() => ({ success: true as const, stdout: FAKE_TOKEN }));
    const sharedDeps = wrapLinkAuthDepsWithMemo({ runCommand });

    const { fetchImpl, requests } = recordingFetch();

    // === Slice 2: validator ===
    const validator = new ExternalLinkValidator(tempDir, {
      linkAuthConfig: engineConfig,
      linkAuthDeps: sharedDeps,
      fetchImpl,
    });
    const validateResult = await validator.validateLink(GITHUB_BLOB_URL);
    expect(validateResult.status).toBe('ok');
    expect(validateResult.statusCode).toBe(200);

    // === Slice 3: primitive on the SAME URL with the SAME config + memo ===
    const contentCache = new ContentCache(
      safePath.join(tempDir, 'content'),
      engineConfig.cache?.ttlMinutes ?? 30,
    );
    const fetchResult = await fetchAuthenticated(GITHUB_BLOB_URL, engineConfig, {
      fetchImpl,
      deps: sharedDeps,
      cache: contentCache,
    });
    if (!('bytes' in fetchResult)) {
      throw new Error('expected fetch result from primitive');
    }
    expect(fetchResult.cached).toBe(false);
    expect(new TextDecoder().decode(fetchResult.bytes)).toBe(SAMPLE_BODY);
    expect(fetchResult.metadata.rewrittenUrl).toBe(GITHUB_CONTENTS_URL);

    // === Slice 3: second call → content cache hit, no fetch issued ===
    const cacheHit = await fetchAuthenticated(GITHUB_BLOB_URL, engineConfig, {
      fetchImpl,
      deps: sharedDeps,
      cache: contentCache,
    });
    if (!('bytes' in cacheHit)) throw new Error('expected cache hit');
    expect(cacheHit.cached).toBe(true);
    expect(new TextDecoder().decode(cacheHit.bytes)).toBe(SAMPLE_BODY);

    // === Cross-slice assertions ===
    // 2 HTTP requests total: slice-2 validator (1) + slice-3 fetch (1).
    // Second slice-3 call was a cache hit (0 requests).
    expect(requests).toHaveLength(2);

    // Both requests hit the rewritten URL (the engine fed the same rewrite
    // to both slices).
    expect(requests.every((r) => r.url === GITHUB_CONTENTS_URL)).toBe(true);

    // §6.2 wire-level dual-mode discipline:
    //   - Slice 2 sends auth.headers Accept (check-mode)
    //   - Slice 3 sends fetch.headers Accept (content retrieval)
    expect(requests[0]?.accept).toBe(GITHUB_JSON_ACCEPT);
    expect(requests[1]?.accept).toBe(GITHUB_RAW_ACCEPT);

    // Both requests carry the same resolved-token Authorization (the shared
    // memo gave both consumers the same token without re-resolving).
    expect(requests[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(requests[1]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);

    // Memo correctness: across 3 cross-slice calls (validator + 2× primitive)
    // the token-resolver ran exactly once. Without the shared memo this
    // would be 3.
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
