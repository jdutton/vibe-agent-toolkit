import { EventEmitter } from 'node:events';

import { describe, expect, it, vi, afterEach } from 'vitest';

import type { HttpRequester } from '../../src/org/org-api-client.js';
import {
  ApiRequestError,
  ApiTransportError,
  CONNECT_TIMEOUT_MS,
  OrgApiClient,
  REQUEST_INACTIVITY_TIMEOUT_MS,
  attemptMayHaveActed,
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
/** The body a rate-limited exchange answers with; scripted by several tests. */
const RATE_LIMITED_BODY = '{"error":{"message":"rate"}}';
/** The message an absent resource's 404 carries in these fixtures. */
const NOT_FOUND_MESSAGE = 'API error 404: not found';
/** What a rethrown 404 reads as, whatever body the fixture gave it. */
const NOT_FOUND_PREFIX = 'API error 404';

// ── Transport test double ──────────────────────────────────────────────
// `https.request` is injected, so the response/timeout/retry handling is exercised
// with no network at all. A 'stall' exchange never answers, which is how the
// inactivity timeout is driven.

/**
 * One scripted outcome.
 *
 * The `reset*` forms exist because a transport failure is not one thing, and the
 * client has to tell them apart: bytes may or may not have left the socket, a
 * socket may not exist yet, and the failure may arrive on the REQUEST or on the
 * RESPONSE stream.
 */
type Exchange =
  | 'stall'
  /** A socket is assigned and reaches whatever readiness event is configured, then silence. */
  | 'connected-stall'
  /** The connection drops after the body was written — the live `socket hang up`. */
  | 'reset'
  /** It drops WITH a socket in hand, before a byte of THIS request was flushed. */
  | 'reset-before-write'
  /** It fails before a socket exists at all — DNS, or a refused connection. */
  | 'reset-before-socket'
  /** It drops after the headers arrived, which emits on the RESPONSE stream. */
  | 'reset-after-headers'
  | ResponseExchange;

interface ResponseExchange {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Bytes the fake charges a request for its HEADERS.
 *
 * Non-zero on purpose. The old fake assigned a fresh socket per request reporting
 * exactly `body.length`, so the byte assertion compared the fixture to itself and
 * could not see that the client was reading a per-SOCKET counter. A real request
 * always writes a header block, so `bytesSent` is never the body length.
 */
const FAKE_HEADER_BYTES = 140;

/**
 * A socket whose `bytesWritten` is CUMULATIVE, as Node's is — the property the
 * fake previously could not express, and the whole reason the defect was
 * invisible. An `EventEmitter` so `'connect'` / `'secureConnect'` are real events
 * the client can wait on.
 */
type FakeSocket = EventEmitter & { bytesWritten: number; connecting: boolean };

/** Which readiness event the fake socket fires; `'none'` is a handshake that never completes. */
type ReadyEvent = 'connect' | 'secureConnect' | 'none';

interface SocketOptions {
  /**
   * One socket shared by every request, as `https.globalAgent` does on Node >= 19
   * (`keepAlive: true` by default). The counter then accumulates across requests.
   */
  keepAlive?: boolean;
  /** What the socket's counter already stood at before the first request. */
  startBytes?: number;
  /** A TLS socket carries `encrypted` and signals readiness with `'secureConnect'`. */
  tls?: boolean;
  readyEvent?: ReadyEvent;
}

function createFakeSocket(startBytes: number, tls: boolean): FakeSocket {
  const socket = Object.assign(new EventEmitter(), { bytesWritten: startBytes, connecting: true });
  if (tls) Object.assign(socket, { encrypted: true });
  return socket;
}

interface CapturedCall {
  options: {
    method?: string;
    hostname?: string;
    port?: string;
    protocol?: string;
    path?: string;
    headers?: Record<string, string>;
  };
  body: Buffer;
  timeoutMs: number | undefined;
  destroyedWith: Error | undefined;
  fireTimeout: () => void;
  /** What THIS request alone put on the wire: headers plus body. */
  bytesThisRequestWrote: number | undefined;
  /** The socket's CUMULATIVE counter once this request was done writing to it. */
  socketBytesWrittenAtEnd: number | undefined;
  /** Run the connect deadline's callback, as an unanswered DNS query would. */
  fireConnectDeadline: () => void;
  connectDeadlineCleared: boolean;
  connectDeadlineUnrefed: boolean;
}

/** Marks the fake handle the connect deadline was given, so clears are attributable. */
const CONNECT_DEADLINE_HANDLE = Symbol('connect-deadline');

/** The one exchange that fails on the RESPONSE stream rather than the request. */
const RESET_AFTER_HEADERS = 'reset-after-headers';

/** A socket is assigned and reaches its readiness event, then nothing more happens. */
const CONNECTED_STALL = 'connected-stall';

/** A socket is assigned, then the connection drops before this request writes a byte. */
const RESET_BEFORE_WRITE = 'reset-before-write';

/**
 * Start a request and let the fake get as far as assigning its socket.
 *
 * A `connected-stall` request never settles, so it is raced against an immediate
 * rather than awaited — awaiting it would hang, and a bare floating promise is a
 * lint error and an unhandled rejection waiting to happen.
 */
async function settleSocketAssignment(pending: Promise<unknown>): Promise<void> {
  await Promise.race([
    pending.catch(() => undefined),
    new Promise((done) => setImmediate(done)),
  ]);
}

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

/**
 * Hand the request its socket the way Node does: emitted on the REQUEST, before a
 * byte is written, and only then signalling readiness. The order is load-bearing —
 * the client takes its byte baseline in the `'socket'` handler, so a fake that
 * wrote first would make every delta zero and pass vacuously.
 */
function assignFakeSocket(
  req: EventEmitter & Record<string, unknown>,
  socket: FakeSocket,
  readyEvent: ReadyEvent,
): void {
  req['socket'] = socket;
  req.emit('socket', socket);
  if (socket.connecting && readyEvent !== 'none') {
    socket.connecting = false;
    socket.emit(readyEvent);
  }
}

/** Charge the socket for this request's headers plus body, cumulatively. */
function chargeSocket(call: CapturedCall, socket: FakeSocket, wroteBody: boolean): void {
  const written = wroteBody ? FAKE_HEADER_BYTES + call.body.length : 0;
  socket.bytesWritten += written;
  call.bytesThisRequestWrote = written;
  call.socketBytesWrittenAtEnd = socket.bytesWritten;
}

function emitScriptedResponse(
  callback: (res: unknown) => void,
  exchange: ResponseExchange | typeof RESET_AFTER_HEADERS,
): void {
  if (exchange === RESET_AFTER_HEADERS) {
    const aborted = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    callback(aborted);
    aborted.emit('error', new Error('aborted'));
    return;
  }
  const res = Object.assign(new EventEmitter(), {
    statusCode: exchange.statusCode ?? 200,
    headers: exchange.headers ?? {},
  });
  callback(res);
  res.emit('data', Buffer.from(exchange.body ?? ''));
  res.emit('end');
}

function createFakeTransport(
  script: Exchange[],
  socketOptions: SocketOptions = {},
): { calls: CapturedCall[]; requester: HttpRequester } {
  const calls: CapturedCall[] = [];
  const pending = [...script];
  const tls = socketOptions.tls ?? true;
  const readyEvent = socketOptions.readyEvent ?? 'secureConnect';
  const startBytes = socketOptions.startBytes ?? 0;
  // One socket for every request, or a fresh one each time — the difference the
  // per-request delta has to survive.
  const shared = socketOptions.keepAlive === true ? createFakeSocket(startBytes, tls) : undefined;
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
      bytesThisRequestWrote: undefined,
      socketBytesWrittenAtEnd: undefined,
      fireConnectDeadline: () => undefined,
      connectDeadlineCleared: false,
      connectDeadlineUnrefed: false,
    };

    const runExchange = (exchange: Exchange): void => {
      if (exchange === 'reset-before-socket') {
        req.emit('error', new Error('getaddrinfo ENOTFOUND api.anthropic.com'));
        return;
      }
      // 'stall' is a DNS blackhole: the request never gets a socket at all.
      if (exchange === 'stall') return;
      const socket = shared ?? createFakeSocket(startBytes, tls);
      assignFakeSocket(req, socket, readyEvent);
      if (exchange === CONNECTED_STALL) return;
      chargeSocket(call, socket, exchange !== RESET_BEFORE_WRITE);
      if (exchange === 'reset' || exchange === RESET_BEFORE_WRITE) {
        req.emit('error', new Error('socket hang up'));
        return;
      }
      emitScriptedResponse(callback, exchange);
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
      if (exchange !== undefined) setImmediate(() => { runExchange(exchange); });
      return req;
    };

    calls.push(call);
    return req;
  };

  return { calls, requester: requester as unknown as HttpRequester };
}

function clientWith(
  script: Exchange[],
  socketOptions: SocketOptions = {},
): { calls: CapturedCall[]; client: OrgApiClient } {
  const { calls, requester } = createFakeTransport(script, socketOptions);
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

  /**
   * Success is 2xx and ONLY 2xx. Refusing merely `>= 400` let a 1xx or 3xx through
   * as `{ ok: true, value: undefined }`, and Node's HTTP client does not follow
   * redirects, so a 3xx arrives here verbatim: a TLS-terminating proxy answering
   * `DELETE /v1/skills/{id}` with `302 Found` and an empty body resolved
   * `undefined`, which the delete reporter reads as "no error type, therefore
   * deleted" — `status: success`, exit 0, skill still there.
   */
  describe('anything outside 2xx is a refusal, not a success', () => {
    it('refuses a 302 with an empty body, which is what a proxy answers a DELETE with', () => {
      const outcome = interpretApiResponse<unknown>(302, '');
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.message).toBe('API error 302: (empty body)');
    });

    it('refuses a 304, naming the status rather than resolving undefined', () => {
      const outcome = interpretApiResponse<unknown>(304, '');
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.message).toContain('304');
    });

    it('refuses a 1xx', () => {
      expect(interpretApiResponse<unknown>(100, '').ok).toBe(false);
    });

    it('refuses a response that never carried a status, instead of coercing it to 0', () => {
      const outcome = interpretApiResponse<unknown>(undefined, '');
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.message).toBe('API error no status: (empty body)');
    });

    it('still accepts the whole 2xx range', () => {
      expect(interpretApiResponse<unknown>(200, '').ok).toBe(true);
      expect(interpretApiResponse<unknown>(299, '').ok).toBe(true);
    });
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

  /**
   * A DELETE answered `302 Found` with an empty body used to RESOLVE `undefined`,
   * which the CLI's delete reporter reads as a successful delete. Exit 0, and the
   * skill still there — the exact shape the reporter was added to eliminate.
   */
  it('rejects a redirect rather than resolving it as a completed DELETE', async () => {
    const { client } = clientWith([{ statusCode: 302, headers: { location: '/elsewhere' }, body: '' }]);
    await expect(client.deleteSkill('skill_1')).rejects.toThrow('API error 302');
  });
});

/**
 * The URL's port and protocol have to reach the transport. They are not reachable
 * today — the base URL is a constant on 443 — but dropping them arms the trap for
 * the first base-URL override, which would then be sent somewhere else in silence.
 */
describe('request options carry the whole URL, not just its host and path', () => {
  it('passes the protocol through, and leaves an absent port undefined rather than empty', async () => {
    const { calls, client } = clientWith([{ statusCode: 200, body: '{}' }]);
    await client.getSkills(SKILLS_PATH);

    expect(calls[0]?.options.protocol).toBe('https:');
    expect(calls[0]?.options.hostname).toBe('api.anthropic.com');
    // `new URL(...).port` is '' for a default port, and '' is not a port.
    expect(calls[0]?.options.port).toBeUndefined();
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
      { statusCode: 429, headers: { 'retry-after': '0' }, body: RATE_LIMITED_BODY },
      { statusCode: 204, body: '' },
    ]);
    await expect(client.deleteSkillVersion('skill_1', 'v1')).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a rate-limited POST, and says why', async () => {
    const { calls, client } = clientWith([
      { statusCode: 429, headers: { 'retry-after': '0' }, body: RATE_LIMITED_BODY },
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
    const multipart = buildMultipartFormData({ display_title: 'x' }, []);
    const { client } = clientWith(['reset']); // a POST is never replayed
    const failure = await client.uploadSkill(multipart).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiTransportError);
    // Headers plus body — computed here, not read back off the fixture. A request
    // always writes a header block, so the count is never the body length.
    expect((failure as ApiTransportError).bytesSent).toBe(FAKE_HEADER_BYTES + multipart.body.length);
    expect((failure as ApiTransportError).bytesSent).not.toBe(multipart.body.length);
    expect((failure as ApiTransportError).deadlineExceeded).toBe(false);
  });

  it('reports zero bytes when no socket was ever assigned', async () => {
    const { client } = clientWith(everyAttempt('reset-before-socket'));
    const failure = await client.getSkills(SKILLS_PATH).catch((error: unknown) => error);

    expect((failure as ApiTransportError).bytesSent).toBe(0);
  });

  /**
   * 🚨 `socket.bytesWritten` is a per-SOCKET cumulative counter, and this client
   * passes no `agent`, so it gets `https.globalAgent` — `keepAlive: true` on Node
   * >= 19. Sequential requests therefore share one socket and the raw counter is
   * the running total: measured locally as 140, 280, 420, 560 across four
   * header-only GETs. Reading it raw made every count after the first a sum of
   * other requests' traffic.
   */
  describe('the byte count belongs to the REQUEST, not to the socket it borrowed', () => {
    const REUSED = { keepAlive: true } as const;

    it('reports only this attempt, on a socket three attempts have written to', async () => {
      const { calls, client } = clientWith(everyAttempt('reset'), REUSED);
      const failure = await client.getSkills(SKILLS_PATH).catch((error: unknown) => error);

      // The fake really is expressing a reused socket: one connection, three
      // requests, a counter that accumulated to their sum.
      expect(calls).toHaveLength(3);
      expect(calls[2]?.socketBytesWrittenAtEnd).toBe(3 * FAKE_HEADER_BYTES);
      // …and the client reports one request's worth, not the socket's total.
      expect((failure as ApiTransportError).bytesSent).toBe(FAKE_HEADER_BYTES);
    });

    /**
     * The `bytesSent === 0` branch is what tells an operator that NOTHING was
     * created. Read raw, it was unreachable after the first request on a
     * keep-alive socket: a reset before a byte of the 4th DELETE was flushed
     * reported the previous three requests' bytes as this one's.
     */
    it('reports zero when a reset beat the first byte out, on an already-written socket', async () => {
      const { calls, client } = clientWith(everyAttempt(RESET_BEFORE_WRITE), {
        keepAlive: true,
        startBytes: 3 * FAKE_HEADER_BYTES,
      });
      const failure = await client.deleteSkill('skill_1').catch((error: unknown) => error);

      expect(calls[0]?.socketBytesWrittenAtEnd).toBe(3 * FAKE_HEADER_BYTES);
      expect((failure as ApiTransportError).bytesSent).toBe(0);
    });
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

// ── A replayed DELETE reading its own success as a failure ─────────────

/**
 * 🚨 "Replaying a DELETE reaches the same end state" is true of the SERVER and
 * false of this client's control flow.
 *
 * The delete lands. Its response is lost on the way back. The replay the client
 * owes that lost response finds the resource already gone and is answered 404 —
 * by the delete it performed itself. A 404 is not retryable, so it was rethrown:
 * `delete --all` exited 1, never attempted the remaining versions, and OMITTED
 * from `deletedVersions` the one version it had definitely destroyed. The
 * operator saw a failure, an incomplete record, and a half-deleted skill.
 *
 * The distinguishing fact is the ATTEMPT NUMBER, and only this client holds it:
 * a 404 on the FIRST attempt is a resource that was never there, and a 404 on a
 * REPLAY is the answer to a request this client already made.
 */
describe('a DELETE replayed after a lost response', () => {
  const GONE = { statusCode: 404, body: '{"error":{"message":"skill version not found"}}' };

  it('reads the 404 as the delete it already performed, not as a failure', async () => {
    // The first attempt reaches the origin and the connection drops before the
    // answer gets back — the shape that makes the replay necessary at all.
    const { calls, client } = clientWith(['reset', GONE]);

    await expect(client.deleteSkillVersion('skill_1', 'v1')).resolves.toBeUndefined();
    // It really did replay: the 404 came from the SECOND exchange.
    expect(calls).toHaveLength(2);
  });

  /**
   * The other side of the same coin, and the reason attempt 0 cannot be folded
   * in: a 404 on the first attempt is a version that was never there, and
   * swallowing that would report a delete that never happened.
   */
  it('still refuses a 404 on the FIRST attempt, which nothing here deleted', async () => {
    const { calls, client } = clientWith([GONE]);

    await expect(client.deleteSkillVersion('skill_1', 'v1')).rejects.toThrow(NOT_FOUND_PREFIX);
    expect(calls).toHaveLength(1);
  });

  /**
   * 🚩 A 404 that answers a rate-limit retry is NOT the same fact, and this test
   * used to pin that it was. `isRetryableFailure` replays a 429 precisely
   * because it is a status that means the origin did NOT act — so after one,
   * nothing this client did removed the resource, and the 404 on the replay is
   * a version that was never there, or that another actor removed. Resolving it
   * reported a delete that never happened: `deleteSkillVersion('skill', 'typo')`
   * under rate limiting resolved, and `delete --all` recorded the version as
   * deleted. The discriminating fact is whether the PRIOR attempt may have
   * reached the origin, not the attempt number.
   */
  it('still refuses a 404 after a 429 replay, because the 429 attempt did not act', async () => {
    const { calls, client } = clientWith([
      { statusCode: 429, headers: { 'retry-after': '0' }, body: RATE_LIMITED_BODY },
      GONE,
    ]);

    await expect(client.deleteSkill('skill_1')).rejects.toThrow(NOT_FOUND_PREFIX);
    // It did replay — the 404 came from the second exchange — and still refused.
    expect(calls).toHaveLength(2);
  });

  /**
   * The lost-response replay keeps its reading through a rate limit that
   * FOLLOWS it: once an attempt may have acted, that fact does not expire.
   */
  it('reads a 404 as its own delete when a transport loss preceded a 429', async () => {
    const { calls, client } = clientWith([
      'reset',
      { statusCode: 429, headers: { 'retry-after': '0' }, body: RATE_LIMITED_BODY },
      GONE,
    ]);

    await expect(client.deleteSkillVersion('skill_1', 'v1')).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  /**
   * A GET is not a delete. Replaying one changes nothing, so a 404 on its replay
   * is a genuine 404 and must stay one — the rule is about the METHOD's effect,
   * not about having retried.
   */
  it('does not swallow a 404 on a replayed GET, which deleted nothing', async () => {
    const { client } = clientWith([
      { statusCode: 503, body: '{}' },
      { statusCode: 404, body: '{}' },
    ]);

    await expect(client.getSkills(SKILLS_PATH)).rejects.toThrow(NOT_FOUND_PREFIX);
  });
});

describe('decideRetry', () => {
  const reset = (): ApiTransportError => new ApiTransportError('socket hang up', 1024);
  const deadline = (): ApiTransportError =>
    new ApiTransportError('timed out', 1024, { deadlineExceeded: true });

  it('replays a dropped connection on an idempotent method', () => {
    expect(decideRetry('DELETE', 0, reset(), false)).toEqual({ delayMs: expect.any(Number) });
  });

  it('never replays a dropped connection on a POST', () => {
    expect(decideRetry('POST', 0, reset(), false)).toEqual({ rethrow: expect.any(ApiTransportError) });
  });

  /**
   * A deadline has already waited its full budget. Replaying one spends it again:
   * three attempts on the 120 s inactivity budget is six minutes of silence
   * before the operator hears anything, which is the opposite of what the
   * timeout was added for.
   */
  it('never replays a deadline, even on an idempotent method', () => {
    expect(decideRetry('DELETE', 0, deadline(), false)).toEqual({ rethrow: expect.any(ApiTransportError) });
  });

  it('passes through an error that never reached the transport', () => {
    const noKey = new Error('ANTHROPIC_API_KEY is required');
    expect(decideRetry('GET', 0, noKey, false)).toEqual({ rethrow: noKey });
  });

  it('stops replaying once the attempt budget is spent', () => {
    expect(decideRetry('DELETE', 99, reset(), true)).toEqual({ rethrow: expect.any(ApiTransportError) });
  });

  /**
   * The policy in one place: a 404 answering a DELETE replayed after an attempt
   * that MAY HAVE ACTED is the end state the caller asked for, so it resolves
   * rather than rethrowing. A prior attempt that certainly did not act — a 429,
   * the statuses the retry policy exists for — leaves the 404 a genuine one,
   * and a replayed GET deleted nothing whatever preceded it.
   */
  it('resolves a 404 that answers a DELETE replayed after a possible act', () => {
    const gone = new ApiRequestError(NOT_FOUND_MESSAGE, 404, undefined);
    expect(decideRetry('DELETE', 1, gone, true)).toEqual({ alreadyGone: true });
  });

  it('rethrows a 404 on a DELETE replayed after an attempt that did not act', () => {
    const gone = new ApiRequestError(NOT_FOUND_MESSAGE, 404, undefined);
    expect(decideRetry('DELETE', 1, gone, false)).toEqual({ rethrow: expect.any(ApiRequestError) });
  });

  it('rethrows a 404 on the FIRST delete attempt', () => {
    const gone = new ApiRequestError(NOT_FOUND_MESSAGE, 404, undefined);
    expect(decideRetry('DELETE', 0, gone, false)).toEqual({ rethrow: expect.any(ApiRequestError) });
  });

  it('rethrows a 404 on a replayed GET, which changed nothing', () => {
    const gone = new ApiRequestError(NOT_FOUND_MESSAGE, 404, undefined);
    expect(decideRetry('GET', 1, gone, true)).toEqual({ rethrow: expect.any(ApiRequestError) });
  });

  /** The fact the loop carries: only a lost response can have acted. */
  it('says which failures may have reached the origin', () => {
    expect(attemptMayHaveActed(reset())).toBe(true);
    expect(attemptMayHaveActed(deadline())).toBe(true);
    expect(attemptMayHaveActed(new ApiRequestError('API error 429', 429, '0'))).toBe(false);
    expect(attemptMayHaveActed(new ApiRequestError('API error 503', 503, undefined))).toBe(false);
    expect(attemptMayHaveActed(new Error('no key'))).toBe(false);
  });

  /**
   * A retryable-looking status that is NOT retried gets rebuilt so the "not
   * retried" note can be appended. The rebuild used to drop the original object
   * and its stack — asymmetric with `ApiTransportError`, which has always plumbed
   * a cause. Diagnosability only, but the asymmetry is the kind that gets copied.
   */
  it('keeps the original error as the cause when it rebuilds one to add a note', () => {
    const original = new ApiRequestError('API error 429: rate', 429, '1');
    const decision = decideRetry('POST', 0, original, false) as { rethrow: ApiRequestError };

    expect(decision.rethrow).not.toBe(original);
    expect(decision.rethrow.message).toContain('Not retried');
    expect(decision.rethrow.cause).toBe(original);
    expect(decision.rethrow.statusCode).toBe(429);
    expect(decision.rethrow.retryAfterHeader).toBe('1');
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

  /**
   * The budget claims to cover "DNS plus TCP plus TLS". For `https` the socket is a
   * `TLSSocket` whose `'connect'` fires when the TCP connection is up — BEFORE the
   * handshake begins; `'secureConnect'` is the handshake-complete signal. Probed
   * against a `net` server that accepts and never speaks TLS: `'connect'` fired at
   * once, `'secureConnect'` never. Disarming on `'connect'` therefore retired the
   * 30 s budget early and dropped the request into the 120 s inactivity budget —
   * four times the documented wait, ending in a message about a connection that
   * "moved no data", which misdescribes a handshake that never started.
   */
  describe('covers the TLS handshake, not just the TCP connect', () => {
    it('stays armed when a TLS socket connects at TCP but never completes the handshake', async () => {
      const { calls, client } = clientWith([CONNECTED_STALL], { tls: true, readyEvent: 'connect' });
      const pending = client.getSkills(SKILLS_PATH).catch((error: unknown) => error);
      // Let the fake assign the socket and fire its TCP 'connect'.
      await settleSocketAssignment(pending);

      expect(calls[0]?.connectDeadlineCleared).toBe(false);

      // The budget is still the one that fires, and it says nothing was sent.
      calls[0]?.fireConnectDeadline();
      const failure = await pending;
      expect(String(failure)).toContain('Could not connect');
      expect((failure as ApiTransportError).bytesSent).toBe(0);
    });

    it('disarms on secureConnect, so a long upload over a live TLS session is never cut off', async () => {
      const { calls, client } = clientWith([CONNECTED_STALL], { tls: true, readyEvent: 'secureConnect' });
      await settleSocketAssignment(client.getSkills(SKILLS_PATH));

      expect(calls[0]?.connectDeadlineCleared).toBe(true);
    });

    it('falls back to connect for a socket with no TLS layer', async () => {
      const { calls, client } = clientWith([CONNECTED_STALL], { tls: false, readyEvent: 'connect' });
      await settleSocketAssignment(client.getSkills(SKILLS_PATH));

      expect(calls[0]?.connectDeadlineCleared).toBe(true);
    });
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
