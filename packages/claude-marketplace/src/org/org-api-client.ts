import { randomBytes } from 'node:crypto';
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

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 60_000;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** A failed HTTP exchange, carrying the status so a caller can branch on it. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | undefined,
    readonly retryAfterHeader: string | undefined,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

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
 */
export function interpretApiResponse<T>(
  statusCode: number | undefined,
  responseText: string,
): ApiResponseOutcome<T> {
  const status = statusCode ?? 0;
  if (status >= 400) {
    return { ok: false, message: `API error ${String(status)}: ${errorDetail(responseText)}` };
  }
  if (responseText.trim() === '') {
    return { ok: true, value: undefined as T };
  }
  try {
    return { ok: true, value: JSON.parse(responseText) as T };
  } catch {
    return {
      ok: false,
      message: `Failed to parse API response (HTTP ${String(status)}): ${quoteBody(responseText)}`,
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
   * Send one request, retrying only what `isRetryableFailure` allows.
   *
   * Retrying matters because these calls run in loops — `delete --all` removes every
   * version before the skill, and a rate limit part-way through used to abort the loop
   * and leave the skill half-deleted. The DELETEs are idempotent, so replaying one is
   * safe. A POST is never replayed; when one fails with a status a retry would have
   * cleared, the error says so instead of silently doing nothing.
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
        if (!(error instanceof ApiRequestError)) throw error;
        if (!isRetryableFailure(method, error.statusCode, attempt)) {
          throw new ApiRequestError(
            error.message + notRetriedNote(method, error.statusCode, attempt + 1),
            error.statusCode,
            error.retryAfterHeader,
          );
        }
        await sleep(nextRetryDelayMs(attempt, parseRetryAfterMs(error.retryAfterHeader, Date.now())));
      }
    }
  }

  private request<T>(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      };

      const req = this.httpRequest(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const outcome = interpretApiResponse<T>(res.statusCode, Buffer.concat(chunks).toString('utf-8'));
          if (outcome.ok) {
            resolve(outcome.value);
            return;
          }
          reject(new ApiRequestError(outcome.message, res.statusCode, retryAfterOf(res.headers)));
        });
      });

      // Node's request timeout is socket INACTIVITY, not total duration, so a slow but
      // progressing 30 MB upload is never cut off — only a connection that has stopped
      // moving is. Without this a stalled TCP connection hung the CLI with no output.
      req.setTimeout(REQUEST_INACTIVITY_TIMEOUT_MS, () => {
        req.destroy(new Error(
          `Request timed out: ${method} ${parsed.origin}${parsed.pathname} moved no data for ` +
          `${String(REQUEST_INACTIVITY_TIMEOUT_MS)}ms. The connection stalled; nothing was confirmed.`,
        ));
      });

      req.on('error', reject);
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
