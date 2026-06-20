import { describe, expect, it } from 'vitest';

import { classifyLink, isLocalFileLink } from '../src/link-parser.js';

describe('classifyLink (exported)', () => {
  it('classifies https URLs as external', () => {
    expect(classifyLink('https://example.com')).toBe('external');
  });
  it('classifies mailto as email', () => {
    expect(classifyLink('mailto:user@example.com')).toBe('email');
  });
  it('classifies fragment-only as anchor', () => {
    expect(classifyLink('#heading')).toBe('anchor');
  });
  it('classifies relative .md path as local_file', () => {
    expect(classifyLink('./docs/foo.md')).toBe('local_file');
    expect(classifyLink('../foo.md')).toBe('local_file');
    expect(classifyLink('docs/foo.md')).toBe('local_file');
  });
  it('classifies local_file with anchor as local_file', () => {
    expect(classifyLink('docs/foo.md#section')).toBe('local_file');
  });
  it('classifies unknown protocols as unknown', () => {
    // eslint-disable-next-line sonarjs/code-eval -- test input; classifyLink must reject this href as 'unknown'
    expect(classifyLink('javascript:void(0)')).toBe('unknown');
    expect(classifyLink('tel:+1234567890')).toBe('unknown');
  });

  describe('local_directory classification', () => {
    it('classifies bare dir/ as local_directory', () => {
      expect(classifyLink('docs/')).toBe('local_directory');
    });
    it('classifies ./docs/ as local_directory', () => {
      expect(classifyLink('./docs/')).toBe('local_directory');
    });
    it('classifies ../docs/ as local_directory', () => {
      expect(classifyLink('../docs/')).toBe('local_directory');
    });
    it('classifies /docs/ as local_directory', () => {
      expect(classifyLink('/docs/')).toBe('local_directory');
    });
    it('does NOT reclassify docs (no trailing slash) — stays local_file', () => {
      expect(classifyLink('docs')).toBe('local_file');
    });
    it('does NOT reclassify docs/x.md (ends in file) — stays local_file', () => {
      expect(classifyLink('docs/x.md')).toBe('local_file');
    });
    it('does NOT reclassify external trailing-slash URL — stays external', () => {
      expect(classifyLink('https://x.com/docs/')).toBe('external');
    });
    it('does NOT reclassify #heading — stays anchor', () => {
      expect(classifyLink('#heading')).toBe('anchor');
    });
  });
});

describe('isLocalFileLink', () => {
  it('returns true for local_file', () => {
    expect(isLocalFileLink('local_file')).toBe(true);
  });
  it('returns true for local_directory', () => {
    expect(isLocalFileLink('local_directory')).toBe(true);
  });
  it('returns false for external', () => {
    expect(isLocalFileLink('external')).toBe(false);
  });
  it('returns false for anchor', () => {
    expect(isLocalFileLink('anchor')).toBe(false);
  });
  it('returns false for email', () => {
    expect(isLocalFileLink('email')).toBe(false);
  });
  it('returns false for unknown', () => {
    expect(isLocalFileLink('unknown')).toBe(false);
  });
});
