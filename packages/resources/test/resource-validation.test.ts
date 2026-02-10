import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '../src/schemas/validation-result.js';

const TEST_URL = 'https://example.com';

describe('external URL validation', () => {
  it('should create external_url_dead issue type', () => {
    const issue: ValidationIssue = {
      resourcePath: '/test.md',
      line: 1,
      type: 'external_url_dead',
      link: TEST_URL,
      message: 'External URL returned 404',
    };
    expect(issue.type).toBe('external_url_dead');
  });

  it('should create external_url_timeout issue type', () => {
    const issue: ValidationIssue = {
      resourcePath: '/test.md',
      line: 1,
      type: 'external_url_timeout',
      link: TEST_URL,
      message: 'Connection timeout after 15s',
    };
    expect(issue.type).toBe('external_url_timeout');
  });

  it('should create external_url_error issue type', () => {
    const issue: ValidationIssue = {
      resourcePath: '/test.md',
      line: 1,
      type: 'external_url_error',
      link: TEST_URL,
      message: 'DNS resolution failed',
    };
    expect(issue.type).toBe('external_url_error');
  });
});
