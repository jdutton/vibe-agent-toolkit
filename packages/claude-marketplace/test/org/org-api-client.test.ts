import { describe, expect, it, vi, afterEach } from 'vitest';

import { OrgApiClient } from '../../src/org/org-api-client.js';

const ADMIN_KEY = 'sk-ant-admin-test';
const API_KEY = 'sk-ant-api-test';

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
