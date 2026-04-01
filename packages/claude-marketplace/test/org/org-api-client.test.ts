import { describe, expect, it, vi, afterEach } from 'vitest';

import { OrgApiClient, buildMultipartFormData, createOrgApiClientFromEnv } from '../../src/org/org-api-client.js';

const ADMIN_KEY = 'sk-ant-admin-test';
const API_KEY = 'sk-ant-api-test';
const ENV_ADMIN_KEY = 'sk-ant-admin-env-test';
const ENV_API_KEY = 'sk-ant-api-env-test';

describe('OrgApiClient', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('constructor validation', () => {
    it('throws a clear error when admin key is missing', () => {
      expect(() => new OrgApiClient({ adminApiKey: '' })).toThrow('ANTHROPIC_ADMIN_API_KEY');
    });
    it('constructs without error when key is provided', () => {
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
      expect(client.buildUrl('/v1/skills')).toBe('https://api.anthropic.com/v1/skills');
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
});
