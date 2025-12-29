import { describe, it, expect } from 'vitest';

import { version, getVersionString } from '../src/version.js';

describe('version', () => {
  it('should export version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should format version without context', () => {
    const result = getVersionString('0.1.0', null);
    expect(result).toBe('0.1.0');
  });

  it('should format version with dev context', () => {
    const result = getVersionString('0.1.0', { type: 'dev', path: '/test/path' });
    expect(result).toBe('0.1.0-dev (/test/path)');
  });

  it('should format version with local context', () => {
    const result = getVersionString('0.1.0', { type: 'local', path: '/project' });
    expect(result).toBe('0.1.0 (local: /project)');
  });

  it('should format version with global context', () => {
    const result = getVersionString('0.1.0', { type: 'global' });
    expect(result).toBe('0.1.0');
  });
});
