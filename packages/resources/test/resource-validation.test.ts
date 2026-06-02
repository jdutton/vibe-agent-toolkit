import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { describe, expect, it } from 'vitest';

const TEST_URL = 'https://example.com';

describe('external URL validation', () => {
  it('should create EXTERNAL_URL_DEAD issue', () => {
    const issue: ValidationIssue = createRegistryIssue('EXTERNAL_URL_DEAD', 'External URL returned 404', {
      location: 'test.md',
      line: 1,
      link: TEST_URL,
    });
    expect(issue.code).toBe('EXTERNAL_URL_DEAD');
  });

  it('should create EXTERNAL_URL_TIMEOUT issue', () => {
    const issue: ValidationIssue = createRegistryIssue('EXTERNAL_URL_TIMEOUT', 'Connection timeout after 15s', {
      location: 'test.md',
      line: 1,
      link: TEST_URL,
    });
    expect(issue.code).toBe('EXTERNAL_URL_TIMEOUT');
  });

  it('should create EXTERNAL_URL_ERROR issue', () => {
    const issue: ValidationIssue = createRegistryIssue('EXTERNAL_URL_ERROR', 'DNS resolution failed', {
      location: 'test.md',
      line: 1,
      link: TEST_URL,
    });
    expect(issue.code).toBe('EXTERNAL_URL_ERROR');
  });
});
