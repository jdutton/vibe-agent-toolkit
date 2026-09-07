import { EventEmitter } from 'node:events';

import { describe, expect, it, vi, afterEach } from 'vitest';

import type { HttpRequester } from '../../src/org/org-api-client.js';
import {
  ApiRequestError,
  ApiTransportError,
  CONNECT_TIMEOUT_MS,
  OrgApiClient,
  REQUEST_INACTIVITY_TIMEOUT_MS,
  buildMultipartFormData,
  createOrgApiClientFromEnv,
  decideRetry,
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

/**
 * One scripted outcome.
 *
 * The three `reset*` forms exist because a transport failure is not one thing,
 * and the client now has to tell them apart: bytes may or may not have left the
 * socket, and the failure may arrive on the REQUEST or on the RESPONSE stream.
 */
type Exchange =
  | 'stall'
  /** The connection drops after the body was written — the live `socket hang up`. */
  | 'reset'
  /** It fails before a socket exists at all — DNS, or a refused connection. */
  | 'reset-before-socket'
  /** It drops after the headers arrived, which emits on the RESPONSE stream. */
  | 'reset-after-headers'
  | { statusCode?: number; headers?: Record<string, string>; body?: string };

interface CapturedCall {
  options: { method?: string; hostname?: string; path?: string; headers?: Record<string, string> };
  body: Buffer;
  timeoutMs: number | undefined;
  destroyedWith: Error | undefined;
  fireTimeout: () => void;
  /** What the fake socket reports as written, or `undefined` if none was assigned. */
  socketBytesWritten: number | undefined;
  /** Run the connect deadline's callback, as an unanswered DNS query would. */
  fireConnectDeadline: () => void;
  connectDeadlineCleared: boolean;
  connectDeadlineUnrefed: boolean;
}

/** Marks the fake handle the connect deadline was given, so clears are attributable. */
const CONNECT_DEADLINE_HANDLE = Symbol('connect-deadline');

/** The one exchange that fails on the RESPONSE stream rather than the request. */
const RESET_AFTER_HEADERS = 'reset-after-headers';

/**
 * Intercept ONLY the connect deadline's timer, so a test can fire it without
 * waiting 30 real seconds and can observe that a successful request cleared it.
 *
 * Keyed on the delay, which is the one property that identifies it here — the
 * inactivity budget goes through `req.setTimeout`, which the fake request object
 * captures separately, and `node:timers/promises` `sleep` is a different binding
 * this does not touch.
 */
function interceptConnectDeadline(currentCall: () => CapturedCall | undefined): void {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void, ms?: number, ...rest: unknown[]
  ) => {
    if (ms !== CONNECT_TIMEOUT_MS) {
      return (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    }
    const call = currentCall();
    const handle = {
      [CONNECT_DEADLINE_HANDLE]: true,
      unref: (): unknown => {
        if (call) call.connectDeadlineUnrefed = true;
        return handle;
      },
    };
    if (call) call.fireConnectDeadline = fn;
    return handle;
  }) as unknown as typeof setTimeout);

  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => {
    if (handle !== null && typeof handle === 'object' && CONNECT_DEADLINE_HANDLE in handle) {
      const call = currentCall();
      if (call) call.connectDeadlineCleared = true;
      return;
    }
    (realClearTimeout as (h: unknown) => void)(handle);
  }) as unknown as typeof clearTimeout);
}

function createFakeTransport(script: Exchange[]): { calls: CapturedCall[]; requester: HttpRequester } {
  const calls: CapturedCall[] = [];
  const pending = [...script];
  interceptConnectDeadline(() => calls.at(-1));

  const requester = (options: unknown, callback: (res: unknown) => void): unknown => {
    const chunks: Buffer[] = [];
    const req: EventEmitter & Record<string, unknown> = Object.assign(new EventEmitter(), {});
    const call: CapturedCall = {
      options: options as CapturedCall['options'],
      body: Buffer.alloc(0),
      timeoutMs: undefined,
      destroyedWith: undefined,
      fireTimeout: () => undefined,
      socketBytesWritten: undefined,
      fireConnectDeadline: () => undefined,
      connectDeadlineCleared: false,
      connectDeadlineUnrefed: false,
    };

    /** Assign a socket the way Node does once the connection is established. */
    const attachSocket = (bytesWritten: number): void => {
      call.socketBytesWritten = bytesWritten;
      req['socket'] = { bytesWritten, connecting: false, once: () => undefined };
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
      if (exchange === 'reset-before-socket') {
        setImmediate(() => req.emit('error', new Error('getaddrinfo ENOTFOUND api.anthropic.com')));
        return req;
      }
      if (exchange === 'reset') {
        attachSocket(call.body.length);
        setImmediate(() => req.emit('error', new Error('socket hang up')));
        return req;
      }
      attachSocket(call.body.length);
      setImmediate(() => {
        const res: EventEmitter & Record<string, unknown> = Object.assign(new EventEmitter(), {
          statusCode: exchange === RESET_AFTER_HEADERS ? 200 : (exchange.statusCode ?? 200),
          headers: exchange === RESET_AFTER_HEADERS ? {} : (exchange.headers ?? {}),
        });
        callback(res);
        if (exchange === RESET_AFTER_HEADERS) {
          res.emit('error', new Error('aborted'));
          return;
        }
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
    // EXACTLY three. `toBeGreaterThan(1) && toBeLessThan(4)` was satisfied by 2
    // as well, so a budget silently cut from 3 to 2 survived the assertion.
    expect(calls).toHaveLength(3);
  });
});

// ── A failure that never earned a status ───────────────────────────────

/**
 * The two rejection shapes are not interchangeable, and the CLI's error text
 * depends on telling them apart: a completed exchange is an `ApiRequestError`
 * carrying a status, and a transport failure is an `ApiTransportError` carrying
 * the bytes that left the socket. The CLI used to infer the second from "not the
 * first", which made a missing API key print "the connection closed … VAT sent
 * 6.8 KiB".
 */
describe('a transport failure carries what actually left the socket', () => {
  /**
   * A GET is idempotent, so a dropped connection IS replayed — the whole
   * attempt budget has to be scripted or the client is left waiting on an
   * exchange the fake never answers. Scripting one and letting the retry stall
   * is how this suite hung the first time it was written.
   */
  const everyAttempt = (exchange: Exchange): Exchange[] => [exchange, exchange, exchange];

  it('rejects with an ApiTransportError naming the bytes written', async () => {
    const { calls, client } = clientWith(everyAttempt('reset'));
    const failure = await client.getSkills(SKILLS_PATH).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiTransportError);
    expect((failure as ApiTransportError).bytesSent).toBe(calls[0]?.socketBytesWritten);
    expect((failure as ApiTransportError).deadlineExceeded).toBe(false);
  });

  it('reports zero bytes when no socket was ever assigned', async () => {
    const { client } = clientWith(everyAttempt('reset-before-socket'));
    const failure = await client.getSkills(SKILLS_PATH).catch((error: unknown) => error);

    expect((failure as ApiTransportError).bytesSent).toBe(0);
  });

  /**
   * A reset AFTER the headers arrived emits on the RESPONSE stream. With no
   * listener there Node turns it into an unhandled 'error' event — a throw out of
   * an emit, not a rejected promise — so the command died with a raw stack.
   */
  it('rejects rather than throwing when the response stream errors', async () => {
    const { client } = clientWith(everyAttempt(RESET_AFTER_HEADERS));

    await expect(client.getSkills(SKILLS_PATH)).rejects.toBeInstanceOf(ApiTransportError);
  });

  it('replays a dropped DELETE, so `delete --all` does not stop half-deleted', async () => {
    // The OTHER half of the half-delete class. Retrying only STATUSES left a
    // dropped connection part-way through the loop aborting it exactly as a 429
    // used to.
    const { calls, client } = clientWith(['reset', { statusCode: 204, body: '' }]);

    await expect(client.deleteSkillVersion('skill_1', 'v1')).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('never replays a dropped POST, which may already have created the skill', async () => {
    const { calls, client } = clientWith(['reset', { statusCode: 200, body: '{"id":"unreachable"}' }]);

    await expect(client.uploadSkill(buildMultipartFormData({}, []))).rejects.toBeInstanceOf(ApiTransportError);
    expect(calls).toHaveLength(1);
  });
});

describe('decideRetry', () => {
  const reset = (): ApiTransportError => new ApiTransportError('socket hang up', 1024);
  const deadline = (): ApiTransportError =>
    new ApiTransportError('timed out', 1024, { deadlineExceeded: true });

  it('replays a dropped connection on an idempotent method', () => {
    expect(decideRetry('DELETE', 0, reset())).toEqual({ delayMs: expect.any(Number) });
  });

  it('never replays a dropped connection on a POST', () => {
    expect(decideRetry('POST', 0, reset())).toEqual({ rethrow: expect.any(ApiTransportError) });
  });

  /**
   * A deadline has already waited its full budget. Replaying one spends it again:
   * three attempts on the 120 s inactivity budget is six minutes of silence
   * before the operator hears anything, which is the opposite of what the
   * timeout was added for.
   */
  it('never replays a deadline, even on an idempotent method', () => {
    expect(decideRetry('DELETE', 0, deadline())).toEqual({ rethrow: expect.any(ApiTransportError) });
  });

  it('passes through an error that never reached the transport', () => {
    const noKey = new Error('ANTHROPIC_API_KEY is required');
    expect(decideRetry('GET', 0, noKey)).toEqual({ rethrow: noKey });
  });

  it('stops replaying once the attempt budget is spent', () => {
    expect(decideRetry('DELETE', 99, reset())).toEqual({ rethrow: expect.any(ApiTransportError) });
  });
});

// ── Getting a socket at all ────────────────────────────────────────────

/**
 * `req.setTimeout` arms on socket ASSIGNMENT, so until a socket exists there is
 * no inactivity to measure. A DNS blackhole — a resolver that accepts the query
 * and never answers — therefore hung the CLI indefinitely with no output, which
 * is precisely the symptom the inactivity timeout was added to prevent.
 */
describe('connect deadline', () => {
  it('destroys the request when no socket ever connects', async () => {
    const { calls, client } = clientWith(['stall']);
    const pending = client.getSkills(SKILLS_PATH).catch((error: unknown) => error);

    calls[0]?.fireConnectDeadline();

    const failure = await pending;
    expect(String(failure)).toContain('Could not connect');
    expect(String(failure)).toContain(String(CONNECT_TIMEOUT_MS));
    // Nothing reached the wire, so the CLI must not speak of an unknown outcome.
    expect((failure as ApiTransportError).bytesSent).toBe(0);
    expect((failure as ApiTransportError).deadlineExceeded).toBe(true);
  });

  it('is cleared once the socket connects, so a long upload is never cut off', async () => {
    const { calls, client } = clientWith([{ statusCode: 200, body: '{"ok":true}' }]);

    await client.getSkills(SKILLS_PATH);

    expect(calls[0]?.connectDeadlineCleared).toBe(true);
  });

  it('never holds the process open on its own', async () => {
    const { calls, client } = clientWith([{ statusCode: 200, body: '{"ok":true}' }]);
    await client.getSkills(SKILLS_PATH);

    expect(calls[0]?.connectDeadlineUnrefed).toBe(true);
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
