import { randomBytes } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const SKILLS_BETA_HEADER = 'skills-2025-10-02';

// ── Multipart form-data builder ────────────────────────────────────────

export interface MultipartFile {
  /** Form field name (e.g. 'files[]') */
  fieldName: string;
  /** Filename as seen by the server */
  filename: string;
  /** File content */
  content: Buffer;
}

export interface MultipartResult {
  body: Buffer;
  boundary: string;
  contentType: string;
}

/**
 * Percent-encode a `Content-Disposition` parameter (`name`, `filename`).
 *
 * RFC 7578 §4.2 requires `"`, CR and LF in these parameters be percent-encoded or
 * rejected; encoding the same three bytes is also what browsers emit. Without it a
 * value carrying CRLF closes the parameter and opens a new header line inside the
 * part — and these values ARE attacker-influenced: on the `--from-npm` path the skill
 * name comes from a downloaded package's YAML frontmatter (a double-quoted scalar
 * decodes `\r\n` into real CRLF), and the filename is spliced from paths in that same
 * package, so injected bytes land in front of a file's content.
 *
 * `%` is deliberately not escaped, matching the browser serialization servers parse.
 */
function escapeHeaderParameter(value: string): string {
  return value.replaceAll('"', '%22').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * Build a multipart/form-data body from string fields and file entries.
 * Pure function — no external dependencies.
 *
 * Field NAMES and FILENAMES are escaped (they are header parameters). Field VALUES are
 * not: a value is a part BODY, which a conformant reader consumes verbatim up to the
 * boundary, so percent-encoding one would corrupt every legitimate value containing a
 * `%`, a quote, or a newline. A hostile value can therefore make a garbage
 * `display_title`, but it cannot forge a part — that needs the boundary, which is 128
 * random bits per request.
 */
export function buildMultipartFormData(
  fields: Record<string, string>,
  files: MultipartFile[],
): MultipartResult {
  const boundary = `----VATBoundary${randomBytes(16).toString('hex')}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeHeaderParameter(name)}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${escapeHeaderParameter(file.fieldName)}"; ` +
        `filename="${escapeHeaderParameter(file.filename)}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Path to a skill's versions collection, or to one version when `version` is given.
 *
 * Both ids are server-minted and opaque, so both are percent-encoded rather than
 * spliced in: an id carrying a `/` would otherwise address a different resource,
 * and for the POST that means appending a version to the wrong skill.
 */
export function skillVersionsPath(skillId: string, version?: string): string {
  const base = `/v1/skills/${encodeURIComponent(skillId)}/versions`;
  return version === undefined ? base : `${base}/${encodeURIComponent(version)}`;
}

/**
 * The HTTPS transport, injectable so the response, timeout and retry handling can be
 * exercised without a network. Defaults to `https.request`.
 */
export type HttpRequester = typeof https.request;

/** Socket-INACTIVITY budget: a slow-but-progressing 30 MB upload is never penalised. */
export const REQUEST_INACTIVITY_TIMEOUT_MS = 120_000;

/**
 * Deadline for getting a CONNECTED socket at all — DNS plus TCP plus TLS.
 *
 * Separate from {@link REQUEST_INACTIVITY_TIMEOUT_MS} because `req.setTimeout`
 * arms on socket ASSIGNMENT: until a socket exists there is no inactivity to
 * measure, so a DNS blackhole (a resolver that accepts the query and never
 * answers) hangs the CLI indefinitely with no output — precisely the symptom the
 * inactivity timeout was added to prevent. This timer starts the moment the
 * request is created and is cleared as soon as the socket connects, so it never
 * penalises a long upload over an established connection.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 60_000;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * A failed HTTP exchange, carrying the status so a caller can branch on it.
 *
 * `options` exists so a re-wrapped failure can keep the one it was built from:
 * {@link decideRetry} rebuilds this error to append a "not retried" note, and
 * without a `cause` that rebuild dropped the original object and its stack —
 * asymmetric with {@link ApiTransportError}, which has always plumbed one.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | undefined,
    readonly retryAfterHeader: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiRequestError';
  }
}

/**
 * A request that never earned a status, carrying the ONE fact a caller needs to
 * describe it honestly: how many bytes actually left this process.
 *
 * 🔑 **The count is recorded, not inferred.** It is read off the socket
 * (`bytesWritten`) at the moment the failure surfaced, as a DELTA from where that
 * socket's counter stood when this request was handed it (see
 * {@link createSocketByteMeter} — the raw counter belongs to the SOCKET, not the
 * request). So `0` is a measurement that nothing was sent — a DNS blackhole, a
 * refused connection, a TLS handshake that never completed, or a reset with a
 * socket in hand before a byte was flushed — and not a guess. That distinction is the whole point of
 * this class: a caller that annotated a failure with "the connection closed and
 * VAT sent N KiB" by testing `!(error instanceof ApiRequestError)` told a
 * first-time operator with no API key that a connection had closed and that a
 * request body had gone out, when the throw happened before a socket existed.
 * **An error's CLASS is not evidence about how far the work got.** This one
 * carries the evidence instead, and an error that never reached the transport is
 * simply not one of these.
 */
export class ApiTransportError extends Error {
  /**
   * True when THIS client gave up on a deadline it set, rather than the network
   * failing. A deadline has already waited its full budget, so replaying it just
   * waits again — three attempts on a 120 s inactivity budget is six minutes of
   * silence before the operator is told anything.
   */
  readonly deadlineExceeded: boolean;

  constructor(
    message: string,
    /** Bytes this process wrote to the socket before the failure — measured, not estimated. */
    readonly bytesSent: number,
    options?: { cause?: unknown; deadlineExceeded?: boolean },
  ) {
    super(message, options);
    this.name = 'ApiTransportError';
    this.deadlineExceeded = options?.deadlineExceeded ?? false;
  }
}

/**
 * A deadline this client imposed — the inactivity budget or the connect budget.
 *
 * A class rather than a message test, because the retry decision must rest on a
 * fact recorded where the decision was MADE, not on parsing the words back out.
 */
class RequestDeadlineExceeded extends Error {}

export type ApiResponseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** Cap on raw body text quoted into an error, so a full HTML page misses the terminal. */
const MAX_QUOTED_BODY_CHARS = 300;

function quoteBody(responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed === '') return '(empty body)';
  if (trimmed.length <= MAX_QUOTED_BODY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_QUOTED_BODY_CHARS)}… (truncated, ${String(trimmed.length)} characters)`;
}

/** The API's own error message when the error body is JSON; the raw body otherwise. */
function errorDetail(responseText: string): string {
  try {
    const parsed: unknown = JSON.parse(responseText);
    const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // Not JSON: an edge proxy's HTML, or a bare gateway error. Fall through to the body.
  }
  return quoteBody(responseText);
}

/**
 * Decide what a completed exchange means, from the status FIRST.
 *
 * The status is read before anything is parsed. Parsing first destroyed it whenever the
 * body was not JSON — an HTML 413 from an edge proxy and a 401 both arrived as
 * `Failed to parse API response: …`, which tells the operator neither "shrink the
 * bundle" nor "get a key". A 2xx with no body is a success, not a parse failure: a
 * DELETE answering 204 has nothing to parse.
 *
 * ⚠️ Success is 2xx and ONLY 2xx. Refusing merely `>= 400` let every 1xx and 3xx
 * through as a success, and Node's HTTP client does not follow redirects, so a 3xx
 * arrives here verbatim: a TLS-terminating proxy answering `DELETE /v1/skills/{id}`
 * with `302 Found` and an empty body resolved `undefined`, which the CLI's delete
 * reporter reads as "no error type, therefore deleted" — `status: success`, exit 0,
 * skill still there. A missing `statusCode` is refused for the same reason: it
 * coerced to `0` and took the success path.
 */
export function interpretApiResponse<T>(
  statusCode: number | undefined,
  responseText: string,
): ApiResponseOutcome<T> {
  if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
    const label = statusCode === undefined ? 'no status' : String(statusCode);
    return { ok: false, message: `API error ${label}: ${errorDetail(responseText)}` };
  }
  if (responseText.trim() === '') {
    return { ok: true, value: undefined as T };
  }
  try {
    return { ok: true, value: JSON.parse(responseText) as T };
  } catch {
    return {
      ok: false,
      message: `Failed to parse API response (HTTP ${String(statusCode)}): ${quoteBody(responseText)}`,
    };
  }
}

/** The single `Retry-After` value, if the response carried one. */
function retryAfterOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['retry-after'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Read a `Retry-After` value as a delay in ms: delta-seconds or an HTTP-date. */
export function parseRetryAfterMs(header: string | undefined, nowMs: number): number | undefined {
  const trimmed = header?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * Whether a failed exchange should be tried again.
 *
 * Only idempotent methods, and only on statuses that mean the origin did NOT act:
 * a rate limit or a gateway refusal. A 500 is excluded because it may mean the origin
 * acted and then failed to answer. A POST is never retried — `POST /v1/skills` creates
 * a skill, and a blind retry would create a duplicate.
 */
export function isRetryableFailure(method: string, statusCode: number | undefined, attempt: number): boolean {
  if (attempt + 1 >= MAX_RETRY_ATTEMPTS) return false;
  if (!IDEMPOTENT_METHODS.has(method.toUpperCase())) return false;
  return statusCode !== undefined && RETRYABLE_STATUSES.has(statusCode);
}

/**
 * Whether a failure that never earned a status should be tried again.
 *
 * A transport failure says nothing about whether the origin acted, so the METHOD
 * has to: replaying a DELETE that may or may not have landed reaches the same end
 * state, replaying a POST can create a second skill. This is the OTHER half of
 * the half-delete class {@link isRetryableFailure} addresses — `delete --all`
 * removes every version in a loop, and a dropped connection part-way through
 * aborted it exactly as a 429 did, leaving the skill half-deleted. Retrying only
 * STATUSES closed one of the two causes, and `send`'s docstring used to claim it
 * closed both.
 */
export function isRetryableTransportFailure(method: string, attempt: number): boolean {
  if (attempt + 1 >= MAX_RETRY_ATTEMPTS) return false;
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Whether a 404 is this client reading its OWN completed delete.
 *
 * 🚨 The retry policy above is justified by "replaying a DELETE reaches the same
 * end state". That is true of the SERVER and false of the caller's control flow.
 * A delete that lands and loses its response is replayed — that is the whole
 * point of {@link isRetryableTransportFailure} — and the replay is answered 404,
 * because the first attempt already removed the thing. Rethrown, that 404 made
 * `delete --all` report a failure for a version it had definitely destroyed,
 * abandon every version after it, and leave the destroyed one out of the record.
 *
 * 🔑 The distinguishing fact is the ATTEMPT NUMBER, and nothing but this client
 * holds it. On attempt 0 a 404 is a resource that was never there and must stay
 * an error; on a replay it is the answer to a request this client already made,
 * and the end state is the one that was asked for.
 *
 * ⚠️ DELETE only, not every idempotent method. A replayed GET changed nothing,
 * so its 404 is a genuine 404. The rule is about the method's EFFECT having
 * already happened, not about having retried.
 */
function isReplayedDeleteOfAbsentResource(
  method: string,
  statusCode: number | undefined,
  attempt: number,
): boolean {
  return method.toUpperCase() === 'DELETE' && attempt > 0 && statusCode === 404;
}

/** Delay before the next attempt: the server's `Retry-After` if it sent one, else backoff. */
export function nextRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  const requested = retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(Math.max(0, requested), RETRY_MAX_DELAY_MS);
}

/**
 * Why a failure that LOOKS transient was not retried — so a rate limit the CLI declined
 * to replay is legible rather than looking like a flat refusal.
 */
function notRetriedNote(method: string, statusCode: number | undefined, attempts: number): string {
  if (statusCode === undefined || !RETRYABLE_STATUSES.has(statusCode)) return '';
  if (!IDEMPOTENT_METHODS.has(method.toUpperCase())) {
    return `\nNot retried: ${method} is not idempotent, so replaying it could create a duplicate. ` +
      'Wait for the limit to clear and re-run the command.';
  }
  return `\nGave up after ${String(attempts)} attempt(s).`;
}

export interface OrgApiClientOptions {
  /** Admin API key (sk-ant-admin...) — required for /v1/organizations/*, and ONLY for those. */
  adminApiKey?: string;
  /** Regular API key (sk-ant-api...) — required for /v1/skills, which never sees the admin key. */
  apiKey?: string;
  /** Transport override. Only a test supplies this; production uses `https.request`. */
  httpRequest?: HttpRequester;
}

export interface PaginationParams {
  limit?: number;
  after_id?: string;
  before_id?: string;
}

export interface ReportPaginationParams {
  starting_at?: string;
  ending_at?: string;
  next_page?: string;
}

/** Wait this long and try again, resolve as already done, or give up with this error. */
export type RetryDecision =
  | { readonly delayMs: number }
  | { readonly rethrow: unknown }
  /** The resource is gone because THIS client's earlier attempt removed it. */
  | { readonly alreadyGone: true };

/**
 * What one failed attempt means for the next one — the WHOLE of the retry
 * policy, in one pure function.
 *
 * Extracted from `send` both to keep that loop under the complexity ceiling and
 * because the policy is the part worth testing directly: three inputs, one
 * decision, no transport. The loop's only job is to honour it.
 *
 * Two failure shapes are handled and they are not symmetric. A status the origin
 * returned is retried per {@link isRetryableFailure}, and when it is not, the
 * error gains {@link notRetriedNote} so a rate limit VAT declined to replay reads
 * as a decision rather than a flat refusal. A failure with NO status is retried
 * per {@link isRetryableTransportFailure} — method-only, since nothing here says
 * whether the origin acted — and is rethrown untouched, because the CLI annotates
 * it from the bytes it carries.
 *
 * There is a third outcome, and it is a SUCCESS: a 404 answering a replayed
 * DELETE is this client reading the effect of its own earlier attempt. See
 * {@link isReplayedDeleteOfAbsentResource} — checked before the retry question,
 * because 404 is not a retryable status and would otherwise fall straight
 * through to the rethrow.
 */
export function decideRetry(method: string, attempt: number, error: unknown): RetryDecision {
  if (error instanceof ApiTransportError) {
    // A deadline is never replayed, whatever the method: it already waited its
    // full budget, so a retry only spends it again — three attempts on the 120 s
    // inactivity budget is six minutes before the operator hears anything.
    const replayable = !error.deadlineExceeded && isRetryableTransportFailure(method, attempt);
    return replayable ? { delayMs: nextRetryDelayMs(attempt) } : { rethrow: error };
  }
  if (!(error instanceof ApiRequestError)) return { rethrow: error };
  if (isReplayedDeleteOfAbsentResource(method, error.statusCode, attempt)) return { alreadyGone: true };
  if (isRetryableFailure(method, error.statusCode, attempt)) {
    return { delayMs: nextRetryDelayMs(attempt, parseRetryAfterMs(error.retryAfterHeader, Date.now())) };
  }
  return {
    rethrow: new ApiRequestError(
      error.message + notRetriedNote(method, error.statusCode, attempt + 1),
      error.statusCode,
      error.retryAfterHeader,
      // The rebuild exists only to append the note; without a cause it discarded the
      // original object and the stack that says where the exchange actually failed.
      { cause: error },
    ),
  };
}

/**
 * The event that means this socket can actually carry the request.
 *
 * ⚠️ For `https` the socket is a `TLSSocket`, and its `'connect'` fires when the TCP
 * connection is established — BEFORE the handshake begins. `'secureConnect'` is the
 * handshake-complete signal. Disarming on `'connect'` retired the connect budget
 * early, so a middlebox that accepts TCP and never completes the handshake fell
 * through to the 120 s inactivity budget: the operator waited four times the
 * documented budget and was then told the connection "moved no data", which
 * misdescribes a handshake that never started. Probed against a `net` server that
 * accepts and never speaks TLS: `'connect'` fired at once, `'secureConnect'` never.
 *
 * A plain socket (an injected transport, or plain `http`) has no `encrypted` marker
 * and never emits `'secureConnect'`, so it keeps `'connect'`.
 */
function readyEventOf(socket: object): 'connect' | 'secureConnect' {
  return 'encrypted' in socket ? 'secureConnect' : 'connect';
}

/**
 * Start the connect deadline and clear it the moment a socket is ready to carry
 * the request — DNS plus TCP plus, for TLS, the handshake.
 *
 * Extracted from `request` because it is a self-contained lifecycle — arm, watch
 * for a connect, disarm — and inlining it pushed that method past the cognitive
 * complexity ceiling.
 */
function armConnectDeadline(
  req: ClientRequest,
  origin: string,
  clear: () => void,
): ReturnType<typeof setTimeout> {
  const deadline = setTimeout(() => {
    req.destroy(new RequestDeadlineExceeded(
      `Could not connect to ${origin} within ${String(CONNECT_TIMEOUT_MS)}ms — ` +
      'DNS resolution or the TCP/TLS handshake never completed, so nothing was sent.',
    ));
  }, CONNECT_TIMEOUT_MS);
  // Never a reason for the process to stay alive; the request itself is.
  deadline.unref?.();
  req.on('socket', (socket) => {
    if (socket.connecting) socket.once(readyEventOf(socket), clear);
    else clear();
  });
  return deadline;
}

/**
 * Measures how many bytes THIS request wrote — the one fact
 * {@link ApiTransportError} carries, and the one the CLI branches on to say
 * whether anything could have been created.
 *
 * 🚨 `socket.bytesWritten` is cumulative PER SOCKET, not per request. This client
 * passes no `agent`, so it uses `https.globalAgent`, which on Node >= 19 defaults
 * to `keepAlive: true`: sequential requests share one socket and the counter
 * accumulates (measured on this machine — four header-only GETs on one keep-alive
 * agent reported 140, 280, 420, 560). Reading it raw made `skills delete --all`
 * claim ~420 B "sent" for a 4th DELETE that had not flushed a byte, and made the
 * `bytesSent === 0` branch — the one that tells an operator NOTHING was created —
 * unreachable after the first request. It also includes the request HEADERS, so it
 * is never the body length even on a fresh socket.
 *
 * 🔑 The fix is the delta, not a fresh socket per request. Keep-alive is worth
 * having for a command that deletes every version of a skill in a loop, and Node
 * unrefs an idle keep-alive socket so it cannot hold the CLI open; forcing
 * `keepAlive: false` would buy a per-connection TLS handshake per delete and still
 * leave the header bytes counted. The baseline is taken in the `'socket'` handler,
 * which Node emits on socket ASSIGNMENT — writes are queued until then — so the
 * delta is exactly this request's traffic.
 */
interface SocketByteMeter {
  /** Register as the request's `'socket'` listener; records the baseline. */
  readonly observeSocket: (socket: unknown) => void;
  /** Bytes this request wrote — `0` when no socket was ever assigned. */
  readonly bytesSent: () => number;
}

function readBytesWritten(socket: { bytesWritten?: unknown } | undefined): number {
  const written: unknown = socket?.bytesWritten;
  return typeof written === 'number' ? written : 0;
}

function createSocketByteMeter(): SocketByteMeter {
  let assigned: { bytesWritten?: unknown } | undefined;
  let baseline = 0;
  return {
    observeSocket: (socket: unknown): void => {
      assigned = socket as { bytesWritten?: unknown };
      baseline = readBytesWritten(assigned);
    },
    bytesSent: (): number =>
      assigned === undefined ? 0 : Math.max(0, readBytesWritten(assigned) - baseline),
  };
}

/**
 * Wire one response to the promise: its body on success, the typed failure
 * otherwise.
 *
 * A separate function so `request` stays under the complexity ceiling, and
 * because the three outcomes here — parsed, refused with a status, reset after
 * the headers — are one decision that belongs together.
 */
function readResponse<T>(
  res: IncomingMessage,
  meter: SocketByteMeter,
  resolve: (value: T) => void,
  reject: (error: Error) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  // A reset AFTER the headers arrived emits on the RESPONSE stream, not the
  // request. With no listener Node turns that into an unhandled 'error' event —
  // a thrown exception out of an emit, not a rejected promise — so the command
  // died with a raw stack instead of the annotated failure the CLI builds.
  res.on('error', (error: Error) => {
    reject(new ApiTransportError(error.message, meter.bytesSent(), { cause: error }));
  });
  res.on('end', () => {
    const outcome = interpretApiResponse<T>(res.statusCode, Buffer.concat(chunks).toString('utf-8'));
    if (outcome.ok) {
      resolve(outcome.value);
      return;
    }
    reject(new ApiRequestError(outcome.message, res.statusCode, retryAfterOf(res.headers)));
  });
}

export class OrgApiClient {
  private readonly adminApiKey: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly httpRequest: HttpRequester;

  /**
   * Neither key is required to construct a client, because this class fronts two
   * surfaces with two different keys: `/v1/organizations/*` takes the admin key,
   * `/v1/skills` takes a regular workspace key and never sees the admin key at all.
   * A construction-time demand for either one locks out the caller who legitimately
   * holds only the other — which is what made `vat claude org skills install` refuse
   * to run for a workspace member whose regular key already authorized the upload.
   * Each key is therefore required at the point it is actually sent.
   */
  constructor(opts: OrgApiClientOptions) {
    this.adminApiKey = opts.adminApiKey;
    this.apiKey = opts.apiKey;
    this.httpRequest = opts.httpRequest ?? https.request;
  }

  buildUrl(path: string): string {
    return `${ANTHROPIC_API_BASE}${path}`;
  }

  buildAdminHeaders(): Record<string, string> {
    if (!this.adminApiKey) {
      throw new Error(
        'ANTHROPIC_ADMIN_API_KEY is required for org administration commands.\n' +
          'Set it in your environment: export ANTHROPIC_ADMIN_API_KEY=sk-ant-admin-...',
      );
    }
    return {
      'x-api-key': this.adminApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };
  }

  buildSkillsHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required for workspace skills commands.\n' +
          'Set it in your environment: export ANTHROPIC_API_KEY=sk-ant-api03-...',
      );
    }
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': SKILLS_BETA_HEADER,
      'content-type': 'application/json',
    };
  }

  buildQueryString(params: Record<string, string | number | undefined>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '';
    const qs = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `?${qs}`;
  }

  /** GET to an org Admin API endpoint. */
  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const extraQs = this.buildQueryString(params);
    let url = this.buildUrl(path);
    if (extraQs) {
      // Join with '&' if path already has query params, otherwise use '?'
      url += path.includes('?') ? extraQs.replace('?', '&') : extraQs;
    }
    const headers = this.buildAdminHeaders();
    return this.send<T>('GET', url, headers);
  }

  /** GET to a skills API endpoint (regular API key + beta header). */
  async getSkills<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = this.buildUrl(path) + this.buildQueryString(params);
    const headers = this.buildSkillsHeaders();
    return this.send<T>('GET', url, headers);
  }

  /** DELETE a skill by ID. All versions must be deleted first. */
  async deleteSkill<T>(skillId: string): Promise<T> {
    const url = this.buildUrl(`/v1/skills/${encodeURIComponent(skillId)}`);
    const headers = this.buildSkillsHeaders();
    return this.send<T>('DELETE', url, headers);
  }

  /** DELETE a specific version of a skill. */
  async deleteSkillVersion<T>(skillId: string, version: string): Promise<T> {
    const url = this.buildUrl(skillVersionsPath(skillId, version));
    const headers = this.buildSkillsHeaders();
    return this.send<T>('DELETE', url, headers);
  }

  /** Upload a skill via multipart/form-data POST to /v1/skills. */
  async uploadSkill<T>(multipart: MultipartResult): Promise<T> {
    return this.postMultipart<T>(this.buildUrl('/v1/skills'), multipart);
  }

  /**
   * Add a new version to an EXISTING skill: multipart POST to
   * `/v1/skills/{id}/versions`.
   *
   * The skill id is taken, never inferred. `display_title` is not unique in a
   * workspace — the API enforces uniqueness only when the field is sent
   * explicitly, and derives a title from SKILL.md frontmatter otherwise, so two
   * skills can and do carry the same title. That makes a title→id lookup a
   * 0-, 1-, or N-match guess, and guessing wrong here appends a version to the
   * wrong skill. The caller supplies the id; `versions list` is how you find it.
   *
   * The server assigns the version identifier and promotes it to
   * `latest_version` — nothing client-side numbers a version.
   */
  async uploadSkillVersion<T>(skillId: string, multipart: MultipartResult): Promise<T> {
    return this.postMultipart<T>(this.buildUrl(skillVersionsPath(skillId)), multipart);
  }

  private postMultipart<T>(url: string, multipart: MultipartResult): Promise<T> {
    const headers: Record<string, string> = {
      ...this.buildSkillsHeaders(),
      'content-type': multipart.contentType, // overrides application/json from buildSkillsHeaders
      'content-length': String(multipart.body.length),
    };
    return this.send<T>('POST', url, headers, multipart.body);
  }

  /**
   * Send one request, retrying only what `isRetryableFailure` (a status) or
   * `isRetryableTransportFailure` (no status at all) allows.
   *
   * Retrying matters because these calls run in loops — `delete --all` removes every
   * version before the skill, and an interruption part-way through used to abort the
   * loop and leave the skill half-deleted. There are TWO ways that happens: a
   * retryable status, and a connection that drops without ever producing one. Both
   * are replayed here, and only for idempotent methods. A POST is never replayed;
   * when one fails with a status a retry would have cleared, the error says so
   * instead of silently doing nothing, and when one fails with no status the caller
   * is told exactly how far it got.
   *
   * A replayed DELETE answered 404 RESOLVES: it is this client reading the effect
   * of the attempt whose response was lost. Rethrowing it turned a completed
   * delete into a reported failure and abandoned the rest of the loop — see
   * {@link isReplayedDeleteOfAbsentResource}.
   */
  private async send<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Buffer,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request<T>(method, url, headers, body);
      } catch (error) {
        const decision = decideRetry(method, attempt, error);
        if ('rethrow' in decision) throw decision.rethrow;
        // The resource is gone because the attempt whose response was lost
        // removed it. Same body a 204 resolves — the API sends none either way,
        // and the caller's report is built from the request, not from an echo.
        if ('alreadyGone' in decision) return undefined as T;
        await sleep(decision.delayMs);
      }
    }
  }

  /**
   * One attempt, resolving the parsed body or rejecting with the error that
   * describes what actually happened.
   *
   * Two rejection shapes, and the difference is load-bearing: a completed
   * exchange is an {@link ApiRequestError} carrying its status, and a failure
   * that never earned one is an {@link ApiTransportError} carrying the bytes
   * that left the socket. Every caller downstream reads the second to decide
   * what it may honestly SAY about the request, so the count is taken from the
   * socket at failure time rather than from the buffer that was handed in — and
   * as a delta against the socket's count at assignment, because the socket may
   * be a keep-alive one that earlier requests already wrote to.
   */
  private request<T>(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        // The port and protocol come from the URL rather than being defaulted by the
        // transport: dropping them made every request implicitly `https:` on 443, a
        // trap armed for the first base-URL override (a proxy, a test server) that
        // would then have been silently sent somewhere else. `parsed.port` is `''`
        // for a default port, which is not a port.
        port: parsed.port || undefined,
        protocol: parsed.protocol,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      };

      // Declared before the request so the response callback can clear it without
      // depending on a hoisted binding.
      let connectDeadline: ReturnType<typeof setTimeout> | undefined;
      const clearConnectDeadline = (): void => {
        if (connectDeadline !== undefined) clearTimeout(connectDeadline);
        connectDeadline = undefined;
      };
      const meter = createSocketByteMeter();

      const req = this.httpRequest(options, (res) => {
        clearConnectDeadline();
        readResponse<T>(res, meter, resolve, reject);
      });
      // Before anything is written: the baseline has to be the socket's count at
      // ASSIGNMENT, or the delta collapses to zero. See createSocketByteMeter.
      req.on('socket', meter.observeSocket);

      // Node's request timeout is socket INACTIVITY, not total duration, so a slow but
      // progressing 30 MB upload is never cut off — only a connection that has stopped
      // moving is. Without this a stalled TCP connection hung the CLI with no output.
      req.setTimeout(REQUEST_INACTIVITY_TIMEOUT_MS, () => {
        req.destroy(new RequestDeadlineExceeded(
          `Request timed out: ${method} ${parsed.origin}${parsed.pathname} moved no data for ` +
          `${String(REQUEST_INACTIVITY_TIMEOUT_MS)}ms. The connection stalled; nothing was confirmed.`,
        ));
      });

      // …and the deadline for getting a socket in the first place, which the one
      // above cannot cover: it arms on socket ASSIGNMENT. See CONNECT_TIMEOUT_MS.
      connectDeadline = armConnectDeadline(req, parsed.origin, clearConnectDeadline);

      req.on('error', (error: Error) => {
        clearConnectDeadline();
        reject(new ApiTransportError(error.message, meter.bytesSent(), {
          cause: error,
          deadlineExceeded: error instanceof RequestDeadlineExceeded,
        }));
      });
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

/**
 * Create an OrgApiClient from environment variables.
 *
 * This NEVER throws. Neither key is required to construct a client, because the two
 * surfaces take different keys; a missing or empty key surfaces with its own message
 * from `buildAdminHeaders()` / `buildSkillsHeaders()`, at the point it would be sent.
 * Both keys are treated identically — set-but-empty is absent — and the options object
 * is assigned to its declared type rather than built from conditional spreads, which
 * get no excess-property check and would let a renamed field go silently unread.
 */
export function createOrgApiClientFromEnv(): OrgApiClient {
  const adminApiKey = process.env['ANTHROPIC_ADMIN_API_KEY'];
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const options: OrgApiClientOptions = {};
  if (adminApiKey !== undefined && adminApiKey !== '') options.adminApiKey = adminApiKey;
  if (apiKey !== undefined && apiKey !== '') options.apiKey = apiKey;
  return new OrgApiClient(options);
}
