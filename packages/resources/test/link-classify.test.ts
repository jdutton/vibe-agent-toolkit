import { describe, expect, it } from 'vitest';

import { classifyLink, isLocalFileLink } from '../src/link-classify.js';
import type { LinkType } from '../src/types.js';

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
  it('classifies inline data: and blob: URIs as embedded (self-contained, nothing to validate)', () => {
    expect(classifyLink('data:image/png;base64,iVBORw0KGgo=')).toBe('embedded');
    expect(classifyLink('data:image/svg+xml;utf8,%3Csvg%3E')).toBe('embedded');
    expect(classifyLink('blob:https://example.com/550e8400-uuid')).toBe('embedded');
  });

  describe('local_directory classification', () => {
    it.each<{ href: string; expected: LinkType }>([
      { href: 'docs/', expected: 'local_directory' },
      { href: './docs/', expected: 'local_directory' },
      { href: '../docs/', expected: 'local_directory' },
      { href: '/docs/', expected: 'local_directory' },
      { href: 'docs', expected: 'local_file' }, // no trailing slash — stays local_file
      { href: 'docs/x.md', expected: 'local_file' }, // ends in a file — stays local_file
      { href: 'https://x.com/docs/', expected: 'external' }, // trailing-slash URL — stays external
      { href: '#heading', expected: 'anchor' }, // fragment-only — stays anchor
    ])('classifies $href as $expected', ({ href, expected }) => {
      expect(classifyLink(href)).toBe(expected);
    });
  });
});

describe('isLocalFileLink', () => {
  it.each<{ type: LinkType; expected: boolean }>([
    { type: 'local_file', expected: true },
    { type: 'local_directory', expected: true },
    { type: 'external', expected: false },
    { type: 'anchor', expected: false },
    { type: 'email', expected: false },
    { type: 'unknown', expected: false },
  ])('returns $expected for $type', ({ type, expected }) => {
    expect(isLocalFileLink(type)).toBe(expected);
  });
});
