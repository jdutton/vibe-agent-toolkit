import { describe, expect, it } from 'vitest';

import { redactUrlCredentials } from '../../src/utils/url-redact.js';

const CLEAN_GITHUB_URL = 'https://github.com/owner/repo.git';

describe('redactUrlCredentials', () => {
  it('should strip x-access-token credentials from HTTPS GitHub URLs', () => {
    const withXAccessToken = 'https://x-access-token:gho_FAKE@github.com/owner/repo.git';
    expect(redactUrlCredentials(withXAccessToken)).toBe(CLEAN_GITHUB_URL);
  });

  it('should strip username:password credentials', () => {
    const withCreds = 'https://alice:hunter2@example.com/repo';
    expect(redactUrlCredentials(withCreds)).toBe('https://example.com/repo');
  });

  it('should strip a bare token used as username', () => {
    const withBareToken = 'https://gho_FAKE@github.com/owner/repo.git';
    expect(redactUrlCredentials(withBareToken)).toBe(CLEAN_GITHUB_URL);
  });

  it('should return HTTPS URLs without credentials unchanged', () => {
    expect(redactUrlCredentials(CLEAN_GITHUB_URL)).toBe(CLEAN_GITHUB_URL);
  });

  it('should return short remote names unchanged', () => {
    expect(redactUrlCredentials('origin')).toBe('origin');
    expect(redactUrlCredentials('upstream')).toBe('upstream');
  });

  it('should return SSH-style git URLs unchanged (not RFC 3986 URLs)', () => {
    // git@github.com:owner/repo.git is not parsed by URL(); passes through.
    // Safe: SSH URLs carry no URL-format userinfo.
    const ssh = 'git@github.com:owner/repo.git';
    expect(redactUrlCredentials(ssh)).toBe(ssh);
  });

  it('should return malformed input unchanged', () => {
    expect(redactUrlCredentials('')).toBe('');
    expect(redactUrlCredentials('not a url')).toBe('not a url');
  });

  it('should preserve @ in pathnames (not userinfo)', () => {
    // An '@' after the host is part of the path, not userinfo.
    const pathWithAt = 'https://github.com/owner/repo@tag';
    expect(redactUrlCredentials(pathWithAt)).toBe(pathWithAt);
  });

  it('should strip credentials from URLs with non-default ports', () => {
    const withPort = 'https://user:token@gitlab.example.com:8443/group/repo.git';
    expect(redactUrlCredentials(withPort)).toBe('https://gitlab.example.com:8443/group/repo.git');
  });

  it('should strip username-only credentials (no password)', () => {
    const userOnly = 'https://alice@example.com/repo';
    expect(redactUrlCredentials(userOnly)).toBe('https://example.com/repo');
  });
});
