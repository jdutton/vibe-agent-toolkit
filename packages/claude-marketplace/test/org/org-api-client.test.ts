import { EventEmitter } from 'node:events';

import { describe, expect, it, vi, afterEach } from 'vitest';

import type { HttpRequester } from '../../src/org/org-api-client.js';
import {
  ApiRequestError,
  OrgApiClient,
  REQUEST_INACTIVITY_TIMEOUT_MS,
  buildMultipartFormData,
  createOrgApiClientFromEnv,
  interpretApiResponse,
  isRetryableFailure,
  nextRetryDelayMs,
  parseRetryAfterMs,
  skillVersionsPath,
} from '../../src/org/org-api-client.js';

const ADMIN_KEY = 'sk-ant-admin-test';
const API_KEY = 'sk-ant-api-test';
const ENV_ADMIN_KEY = 'sk-ant-admin-env-test';
const ENV_API_KEY = 'sk-ant-api-env-test';
const SKILLS_PATH = '/v1/skills';

// ── Transport test double ──────────────────────────────────────────────
// `https.request` is injected, so the response/timeout/retry handling is exercised
// with no network at all. A 'stall' exchange never answers, which is how the
// inactivity timeout is driven.

type Exchange = 'stall' | { statusCode?: number; headers?: Record<string, string>; body?: string };

interface CapturedCall {
  options: { method?: string; hostname?: string; path?: string; headers?: Record<string, string> };
  body: Buffer;
  timeoutMs: number | undefined;
  destroyedWith: Error | undefined;
  fireTimeout: () => void;
}

function createFakeTransport(script: Exchange[]): { calls: CapturedCall[]; requester: HttpRequester } {
  const calls: CapturedCall[] = [];
  const pending = [...script];

  const requester = (options: unknown, callback: (res: unknown) => void): unknown => {
    const chunks: Buffer[] = [];
    const req: EventEmitter & Record<string, unknown> = Object.assign(new EventEmitter(), {});
    const call: CapturedCall = {
      options: options as CapturedCall['options'],
      body: Buffer.alloc(0),
      timeoutMs: undefined,
      destroyedWith: undefined,
      fireTimeout: () => undefined,
    };

    req['setTimeout'] = (ms: number, onTimeout: () => void): unknown => {
      call.timeoutMs = ms;
      call.fireTimeout = onTimeout;
      return req;
    };
    req['write'] = (chunk: Buffer): boolean => {
      chunks.push(chunk);
      return true;
    };
    req['destroy'] = (error?: Error): unknown => {
      call.destroyedWith = error;
      if (error) req.emit('error', error);
      return req;
    };
    req['end'] = (): unknown => {
      call.body = Buffer.concat(chunks);
      const exchange = pending.shift();
      if (exchange === undefined || exchange === 'stall') return req;
      setImmediate(() => {
        const res: EventEmitter & Record<string, unknown> = Object.assign(new EventEmitter(), {
          statusCode: exchange.statusCode ?? 200,
          headers: exchange.headers ?? {},
        });
        callback(res);
        res.emit('data', Buffer.from(exchange.body ?? ''));
        res.emit('end');
      });
      return req;
    };

    calls.push(call);
    return req;
  };

  return { calls, requester: requester as unknown as HttpRequester };
}

function clientWith(script: Exchange[]): { calls: CapturedCall[]; client: OrgApiClient } {
  const { calls, requester } = createFakeTransport(script);
  return { calls, client: new OrgApiClient({ apiKey: API_KEY, httpRequest: requester }) };
}

describe('OrgApiClient', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('key requirements are per-surface, not per-client', () => {
    // The two surfaces this client speaks to take DIFFERENT keys: /v1/organizations/*
    // takes the admin key, /v1/skills takes a regular workspace key and never sees the
    // admin key at all. So neither key can be a construction-time requirement — demanding
    // the admin key up front locks a workspace member out of the skills endpoints their
    // own key already authorizes, which is exactly the shape `vat claude org skills
    // install` shipped with. Each requirement is asserted where the key is actually used.
    it('constructs with only a regular API key, for the skills-endpoint caller', () => {
      expect(() => new OrgApiClient({ apiKey: API_KEY })).not.toThrow();
    });
    it('lets a skills-only client build skills headers and send its own key', () => {
      const client = new OrgApiClient({ apiKey: API_KEY });
      expect(client.buildSkillsHeaders()['x-api-key']).toBe(API_KEY);
    });
    it('throws only when an ADMIN endpoint is reached without an admin key', () => {
      const client = new OrgApiClient({ apiKey: API_KEY });
      expect(() => client.buildAdminHeaders()).toThrow('ANTHROPIC_ADMIN_API_KEY');
    });
    it('constructs without error when the admin key is provided', () => {
      expect(() => new OrgApiClient({ adminApiKey: ADMIN_KEY })).not.toThrow();
    });
  });

  describe('buildUrl', () => {
    it('builds correct URL for org endpoint', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY });
      expect(client.buildUrl('/v1/organizations/me')).toBe('https://api.anthropic.com/v1/organizations/me');
    });
    it('builds correct URL for skills endpoint', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY, apiKey: API_KEY });
      expect(client.buildUrl(SKILLS_PATH)).toBe('https://api.anthropic.com/v1/skills');
    });
  });

  describe('buildAdminHeaders', () => {
    it('includes x-api-key and anthropic-version for admin endpoints', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY });
      const headers = client.buildAdminHeaders();
      expect(headers['x-api-key']).toBe(ADMIN_KEY);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
    });
  });

  describe('buildSkillsHeaders', () => {
    it('includes beta header for skills endpoints', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY, apiKey: API_KEY });
      const headers = client.buildSkillsHeaders();
      expect(headers['anthropic-beta']).toBe('skills-2025-10-02');
      expect(headers['x-api-key']).toBe(API_KEY);
    });
    it('throws when regular API key missing for skills', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY });
      expect(() => client.buildSkillsHeaders()).toThrow('ANTHROPIC_API_KEY');
    });
  });

  describe('buildQueryString', () => {
    it('builds correct query string from params', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY });
      expect(client.buildQueryString({ limit: 100, after_id: 'abc' })).toBe('?limit=100&after_id=abc');
    });
    it('returns empty string when no params', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY });
      expect(client.buildQueryString({})).toBe('');
    });
    it('excludes undefined values', () => {
      const client = new OrgApiClient({ adminApiKey: ADMIN_KEY });
      expect(client.buildQueryString({ limit: 100, after_id: undefined })).toBe('?limit=100');
    });
  });
});

describe('buildMultipartFormData', () => {
  it('builds multipart body with string fields', () => {
    const result = buildMultipartFormData({ display_title: 'My Skill' }, []);
    const bodyStr = result.body.toString('utf-8');

    expect(result.contentType).toContain('multipart/form-data; boundary=');
    expect(bodyStr).toContain('Content-Disposition: form-data; name="display_title"');
    expect(bodyStr).toContain('My Skill');
    expect(bodyStr).toContain(`--${result.boundary}--`);
  });

  it('builds multipart body with files', () => {
    const content = Buffer.from('# Test SKILL.md');
    const result = buildMultipartFormData(
      { display_title: 'test' },
      [{ fieldName: 'files[]', filename: 'skill/SKILL.md', content }],
    );
    const bodyStr = result.body.toString('utf-8');

    expect(bodyStr).toContain('filename="skill/SKILL.md"');
    expect(bodyStr).toContain('Content-Type: application/octet-stream');
    expect(bodyStr).toContain('# Test SKILL.md');
  });

  it('includes multiple files with correct boundaries', () => {
    const result = buildMultipartFormData(
      { display_title: 'multi' },
      [
        { fieldName: 'files[]', filename: 'a/SKILL.md', content: Buffer.from('skill') },
        { fieldName: 'files[]', filename: 'a/ref.md', content: Buffer.from('ref') },
      ],
    );
    const bodyStr = result.body.toString('utf-8');

    expect(bodyStr).toContain('filename="a/SKILL.md"');
    expect(bodyStr).toContain('filename="a/ref.md"');
    // Final boundary marker
    expect(bodyStr).toContain(`--${result.boundary}--`);
  });

  it('generates unique boundaries', () => {
    const r1 = buildMultipartFormData({}, []);
    const r2 = buildMultipartFormData({}, []);
    expect(r1.boundary).not.toBe(r2.boundary);
  });

  // RFC 7578 §4.2 requires `"`, CR and LF in a `Content-Disposition` parameter be
  // percent-encoded or rejected. These values are attacker-influenced on the
  // `--from-npm` path: the skill name is read from a downloaded package's YAML
  // frontmatter, and a double-quoted YAML scalar decodes `\r\n` into real CRLF.
  describe('header parameters are escaped, because they are attacker-influenced', () => {
    it('percent-encodes quote, CR and LF in a field name', () => {
      const result = buildMultipartFormData({ 'a"\r\nX': 'v' }, []);
      expect(result.body.toString('utf-8')).toContain('name="a%22%0D%0AX"');
    });

    it('percent-encodes a filename, so no second header line can be prepended to file content', () => {
      const result = buildMultipartFormData({}, [
        {
          fieldName: 'files[]',
          filename: 'ok/SKILL.md"\r\nContent-Type: text/html\r\n\r\nPWNED',
          content: Buffer.from('real'),
        },
      ]);
      const bodyStr = result.body.toString('utf-8');

      expect(bodyStr).toContain(
        'filename="ok/SKILL.md%22%0D%0AContent-Type: text/html%0D%0A%0D%0APWNED"',
      );
      // One part, so exactly one Content-Disposition line — the injected one is inert text.
      expect(bodyStr.match(/Content-Disposition:/g)).toHaveLength(1);
      // The file's own content is not preceded by attacker bytes.
      expect(bodyStr).toContain('application/octet-stream\r\n\r\nreal\r\n');
    });

    it('escapes the field name of a file part too', () => {
      const result = buildMultipartFormData({}, [
        { fieldName: 'files[]\r\nX: y', filename: 'a.md', content: Buffer.from('c') },
      ]);
      expect(result.body.toString('utf-8')).toContain('name="files[]%0D%0AX: y"');
    });

    // Deliberate asymmetry, pinned so nobody "fixes" it: a field VALUE is a part BODY.
    // A conformant reader consumes it verbatim to the boundary, so escaping it would
    // corrupt every legitimate value carrying `%`, a quote, or a newline.
    it('leaves a field VALUE byte-exact', () => {
      const value = 'line1\r\nline2 "quoted" 100% done';
      const result = buildMultipartFormData({ display_title: value }, []);
      expect(result.body.toString('utf-8')).toContain(`\r\n\r\n${value}\r\n--`);
    });
  });
});

describe('skillVersionsPath', () => {
  it('addresses the versions collection, which is where a new version is POSTed', () => {
    expect(skillVersionsPath('skill_abc123')).toBe('/v1/skills/skill_abc123/versions');
  });

  it('addresses a single version when one is named', () => {
    expect(skillVersionsPath('skill_abc123', '1775007400733130'))
      .toBe('/v1/skills/skill_abc123/versions/1775007400733130');
  });

  it('percent-encodes both ids rather than splicing them into the path', () => {
    // Both are server-minted and opaque. One carrying a slash would otherwise
    // address a different resource — and for the POST that means appending a
    // version to somebody else's skill.
    expect(skillVersionsPath('skill/../evil')).toBe('/v1/skills/skill%2F..%2Fevil/versions');
    expect(skillVersionsPath('s', '../../x')).toBe('/v1/skills/s/versions/..%2F..%2Fx');
  });
});

describe('createOrgApiClientFromEnv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads ANTHROPIC_ADMIN_API_KEY from environment', () => {
    vi.stubEnv('ANTHROPIC_ADMIN_API_KEY', ENV_ADMIN_KEY);
    vi.stubEnv('ANTHROPIC_API_KEY', ENV_API_KEY);

    const client = createOrgApiClientFromEnv();
    const headers = client.buildAdminHeaders();
    expect(headers['x-api-key']).toBe(ENV_ADMIN_KEY);
  });

  it('passes API key when present', () => {
    vi.stubEnv('ANTHROPIC_ADMIN_API_KEY', ENV_ADMIN_KEY);
    vi.stubEnv('ANTHROPIC_API_KEY', ENV_API_KEY);

    const client = createOrgApiClientFromEnv();
    const headers = client.buildSkillsHeaders();
    expect(headers['x-api-key']).toBe(ENV_API_KEY);
  });

  it('works without API key (skills headers will throw later)', () => {
    vi.stubEnv('ANTHROPIC_ADMIN_API_KEY', ENV_ADMIN_KEY);
    delete process.env['ANTHROPIC_API_KEY'];

    const client = createOrgApiClientFromEnv();
    expect(() => client.buildSkillsHeaders()).toThrow('ANTHROPIC_API_KEY');
  });

  // Both keys are treated the same way: set-but-empty is absent, and neither absence
  // is a construction error. This pins the symmetry so the two branches cannot drift.
  it('treats an empty value for EITHER key as absent, and still constructs', () => {
    vi.stubEnv('ANTHROPIC_ADMIN_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const client = createOrgApiClientFromEnv();
    expect(() => client.buildAdminHeaders()).toThrow('ANTHROPIC_ADMIN_API_KEY');
    expect(() => client.buildSkillsHeaders()).toThrow('ANTHROPIC_API_KEY');
  });
});

// ── D1: the status code must survive a non-JSON body ───────────────────

describe('interpretApiResponse', () => {
  it('keeps the status code when a 4xx body is not JSON', () => {
    // An edge proxy answers a too-large upload with HTML. Parsing first destroyed the
    // 413, so "shrink the bundle" and "get a key" arrived as the same message.
    const outcome = interpretApiResponse<unknown>(413, '<html><body>Payload Too Large</body></html>');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.message).toContain('API error 413');
  });

  it('keeps the status code when a gateway answers 502 with no body at all', () => {
    const outcome = interpretApiResponse<unknown>(502, '');
    expect(outcome.ok ? '' : outcome.message).toBe('API error 502: (empty body)');
  });

  it('prefers the API error message when the error body IS JSON', () => {
    const outcome = interpretApiResponse<unknown>(401, '{"error":{"message":"invalid x-api-key"}}');
    expect(outcome.ok ? '' : outcome.message).toBe('API error 401: invalid x-api-key');
  });

  it('accepts a 2xx with an empty body, because a 204 DELETE succeeded', () => {
    expect(interpretApiResponse<unknown>(204, '')).toEqual({ ok: true, value: undefined });
  });

  it('still reports a 2xx body that is not JSON, and names the status', () => {
    const outcome = interpretApiResponse<unknown>(200, 'not json');
    expect(outcome.ok ? '' : outcome.message).toContain('Failed to parse API response (HTTP 200)');
  });

  it('truncates a long body so a full HTML page does not land in the terminal', () => {
    const outcome = interpretApiResponse<unknown>(413, `<html>${'x'.repeat(5000)}</html>`);
    const message = outcome.ok ? '' : outcome.message;
    expect(message.length).toBeLessThan(500);
    expect(message).toContain('truncated');
  });

  it('parses a successful JSON body', () => {
    expect(interpretApiResponse<{ id: string }>(200, '{"id":"skill_1"}'))
      .toEqual({ ok: true, value: { id: 'skill_1' } });
  });
});

describe('request status handling, end to end through the transport', () => {
  it('rejects a non-JSON 413 with the status, not with a parse failure', async () => {
    const { client } = clientWith([{ statusCode: 413, body: '<html>too big</html>' }]);
    await expect(client.uploadSkill(buildMultipartFormData({}, []))).rejects.toThrow('API error 413');
  });

  it('resolves a DELETE that answers 204 with an empty body', async () => {
    const { client } = clientWith([{ statusCode: 204, body: '' }]);
    await expect(client.deleteSkill('skill_1')).resolves.toBeUndefined();
  });

  it('rejects with an ApiRequestError, so a caller can branch on the status', async () => {
    const { client } = clientWith([{ statusCode: 404, body: 'nope' }]);
    await expect(client.getSkills(SKILLS_PATH)).rejects.toBeInstanceOf(ApiRequestError);
  });
});

// ── D2: a stalled connection must not hang forever ─────────────────────

describe('inactivity timeout', () => {
  it('arms a socket-inactivity timeout on every request', async () => {
    const { calls, client } = clientWith(['stall']);
    const pending = client.getSkills(SKILLS_PATH).catch((error: unknown) => error);
    const call = calls[0];
    expect(call?.timeoutMs).toBe(REQUEST_INACTIVITY_TIMEOUT_MS);

    call?.fireTimeout();
    expect(String(await pending)).toContain('timed out');
    expect(call?.destroyedWith).toBeInstanceOf(Error);
  });

  it('names the method and path that stalled, and carries no header value', async () => {
    const { calls, client } = clientWith(['stall']);
    const pending = client.deleteSkill('skill_abc').catch((error: unknown) => error);
    calls[0]?.fireTimeout();
    const message = String(await pending);

    expect(message).toContain('DELETE');
    expect(message).toContain('/v1/skills/skill_abc');
    expect(message).toContain(String(REQUEST_INACTIVITY_TIMEOUT_MS));
    expect(message).not.toContain(API_KEY);
  });
});

// ── D3: retry policy ───────────────────────────────────────────────────

describe('parseRetryAfterMs', () => {
  const NOW = Date.parse('2026-09-06T12:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('3', NOW)).toBe(3000);
  });
  it('reads an HTTP-date as a delay from now', () => {
    expect(parseRetryAfterMs('Sun, 06 Sep 2026 12:00:05 GMT', NOW)).toBe(5000);
  });
  it('never returns a negative delay for a date already past', () => {
    expect(parseRetryAfterMs('Sun, 06 Sep 2026 11:59:00 GMT', NOW)).toBe(0);
  });
  it('returns undefined for a missing or unparseable value', () => {
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined();
    expect(parseRetryAfterMs('   ', NOW)).toBeUndefined();
  });
});

describe('isRetryableFailure', () => {
  it('retries a rate-limited DELETE, which is idempotent', () => {
    expect(isRetryableFailure('DELETE', 429, 0)).toBe(true);
  });
  it('retries an unavailable GET', () => {
    expect(isRetryableFailure('GET', 503, 0)).toBe(true);
  });
  it('never retries a POST, which creates a resource', () => {
    expect(isRetryableFailure('POST', 429, 0)).toBe(false);
  });
  it('does not retry a status that will not clear on its own', () => {
    expect(isRetryableFailure('GET', 401, 0)).toBe(false);
    expect(isRetryableFailure('GET', 404, 0)).toBe(false);
  });
  it('does not retry a 500, which may mean the origin already acted', () => {
    expect(isRetryableFailure('DELETE', 500, 0)).toBe(false);
  });
  it('stops once the attempt budget is spent', () => {
    expect(isRetryableFailure('GET', 429, 99)).toBe(false);
  });
});

describe('nextRetryDelayMs', () => {
  it('honours Retry-After when the server sent one', () => {
    expect(nextRetryDelayMs(0, 7000)).toBe(7000);
  });
  it('backs off exponentially when it did not', () => {
    expect(nextRetryDelayMs(1)).toBeGreaterThan(nextRetryDelayMs(0));
  });
  it('caps a hostile Retry-After so the CLI cannot be parked for an hour', () => {
    expect(nextRetryDelayMs(0, 3_600_000)).toBeLessThanOrEqual(60_000);
  });
});

describe('retry, end to end through the transport', () => {
  it('retries a rate-limited DELETE so `delete --all` does not stop half-deleted', async () => {
    const { calls, client } = clientWith([
      { statusCode: 429, headers: { 'retry-after': '0' }, body: '{"error":{"message":"rate"}}' },
      { statusCode: 204, body: '' },
    ]);
    await expect(client.deleteSkillVersion('skill_1', 'v1')).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a rate-limited POST, and says why', async () => {
    const { calls, client } = clientWith([
      { statusCode: 429, headers: { 'retry-after': '0' }, body: '{"error":{"message":"rate"}}' },
      { statusCode: 200, body: '{"id":"should_not_be_reached"}' },
    ]);
    await expect(client.uploadSkill(buildMultipartFormData({}, []))).rejects.toThrow(/not retried/i);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the attempt budget, keeping the original status in the message', async () => {
    const rateLimited: Exchange = { statusCode: 429, headers: { 'retry-after': '0' }, body: '{}' };
    const { calls, client } = clientWith([rateLimited, rateLimited, rateLimited, rateLimited]);
    await expect(client.getSkills(SKILLS_PATH)).rejects.toThrow('API error 429');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(4);
  });
});

// ── D7: the version-upload method and the content-type override ────────

describe('uploadSkillVersion', () => {
  it('POSTs to the versions collection of the skill it was given', async () => {
    const { calls, client } = clientWith([{ statusCode: 200, body: '{"id":"skill_1"}' }]);
    await client.uploadSkillVersion('skill_abc123', buildMultipartFormData({}, []));

    expect(calls[0]?.options.method).toBe('POST');
    expect(calls[0]?.options.path).toBe('/v1/skills/skill_abc123/versions');
  });

  it('percent-encodes the id on the wire, not only in the path builder', async () => {
    const { calls, client } = clientWith([{ statusCode: 200, body: '{}' }]);
    await client.uploadSkillVersion('skill/../evil', buildMultipartFormData({}, []));
    expect(calls[0]?.options.path).toBe('/v1/skills/skill%2F..%2Fevil/versions');
  });

  it('sends the multipart content-type, overriding the JSON default from buildSkillsHeaders', async () => {
    const multipart = buildMultipartFormData({ display_title: 'x' }, []);
    const { calls, client } = clientWith([{ statusCode: 200, body: '{}' }]);
    await client.uploadSkillVersion('skill_abc123', multipart);

    const headers = calls[0]?.options.headers ?? {};
    expect(headers['content-type']).toBe(multipart.contentType);
    expect(headers['content-type']).not.toBe('application/json');
    expect(headers['content-length']).toBe(String(multipart.body.length));
    expect(headers['anthropic-beta']).toBe('skills-2025-10-02');
  });

  it('sends the multipart body bytes', async () => {
    const multipart = buildMultipartFormData({ display_title: 'sentinel-value' }, []);
    const { calls, client } = clientWith([{ statusCode: 200, body: '{}' }]);
    await client.uploadSkillVersion('skill_abc123', multipart);
    expect(calls[0]?.body.toString('utf-8')).toContain('sentinel-value');
  });
});
