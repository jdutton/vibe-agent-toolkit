import { randomBytes } from 'node:crypto';
import https from 'node:https';

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
 * Build a multipart/form-data body from string fields and file entries.
 * Pure function — no external dependencies.
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
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n` +
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

export interface OrgApiClientOptions {
  /** Admin API key (sk-ant-admin...) — required for /v1/organizations/* */
  adminApiKey: string;
  /** Regular API key (sk-ant-api...) — required for /v1/skills */
  apiKey?: string;
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
  private readonly adminApiKey: string;
  private readonly apiKey: string | undefined;

  constructor(opts: OrgApiClientOptions) {
    if (!opts.adminApiKey) {
      throw new Error(
        'ANTHROPIC_ADMIN_API_KEY is required for org administration commands.\n' +
          'Set it in your environment: export ANTHROPIC_ADMIN_API_KEY=sk-ant-admin-...',
      );
    }
    this.adminApiKey = opts.adminApiKey;
    this.apiKey = opts.apiKey;
  }

  buildUrl(path: string): string {
    return `${ANTHROPIC_API_BASE}${path}`;
  }

  buildAdminHeaders(): Record<string, string> {
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
    return this.request<T>('GET', url, headers);
  }

  /** GET to a skills API endpoint (regular API key + beta header). */
  async getSkills<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = this.buildUrl(path) + this.buildQueryString(params);
    const headers = this.buildSkillsHeaders();
    return this.request<T>('GET', url, headers);
  }

  /** DELETE a skill by ID. All versions must be deleted first. */
  async deleteSkill<T>(skillId: string): Promise<T> {
    const url = this.buildUrl(`/v1/skills/${encodeURIComponent(skillId)}`);
    const headers = this.buildSkillsHeaders();
    return this.request<T>('DELETE', url, headers);
  }

  /** DELETE a specific version of a skill. */
  async deleteSkillVersion<T>(skillId: string, version: string): Promise<T> {
    const url = this.buildUrl(
      `/v1/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}`,
    );
    const headers = this.buildSkillsHeaders();
    return this.request<T>('DELETE', url, headers);
  }

  /** Upload a skill via multipart/form-data POST to /v1/skills. */
  async uploadSkill<T>(multipart: MultipartResult): Promise<T> {
    const url = this.buildUrl('/v1/skills');
    const headers: Record<string, string> = {
      ...this.buildSkillsHeaders(),
      'content-type': multipart.contentType, // overrides application/json from buildSkillsHeaders
      'content-length': String(multipart.body.length),
    };
    return this.request<T>('POST', url, headers, multipart.body);
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

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf-8');
          try {
            const parsedBody: unknown = JSON.parse(responseText);
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              const err = parsedBody as { error?: { message?: string } };
              reject(
                new Error(`API error ${String(res.statusCode)}: ${err.error?.message ?? responseText}`),
              );
              return;
            }
            resolve(parsedBody as T);
          } catch {
            reject(new Error(`Failed to parse API response: ${responseText}`));
          }
        });
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
 * Throws with a clear message if the required key is missing.
 */
export function createOrgApiClientFromEnv(): OrgApiClient {
  const adminKey = process.env['ANTHROPIC_ADMIN_API_KEY'] ?? '';
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  return new OrgApiClient({
    adminApiKey: adminKey,
    ...(apiKey !== undefined && { apiKey }),
  });
}
