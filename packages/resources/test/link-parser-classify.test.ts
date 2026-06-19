import { describe, expect, it } from 'vitest';

import { classifyLink } from '../src/link-parser.js';

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
  it('classifies trailing-slash hrefs as local_directory', () => {
    expect(classifyLink('docs/')).toBe('local_directory');
    expect(classifyLink('./docs/')).toBe('local_directory');
    expect(classifyLink('../docs/')).toBe('local_directory');
    expect(classifyLink('/docs/')).toBe('local_directory');
    expect(classifyLink('/')).toBe('local_directory');
  });
  it('keeps external trailing-slash URLs external (directory rule is local-only)', () => {
    expect(classifyLink('https://example.com/docs/')).toBe('external');
    expect(classifyLink('http://example.com/')).toBe('external');
  });
  it('keeps slashless directory-shaped hrefs as local_file (resolved by stat)', () => {
    // `docs` (no slash, no extension) stays shape-ambiguous — validator
    // resolves it via the filesystem; once resolved to a directory it is
    // treated identically to `docs/`.
    expect(classifyLink('docs')).toBe('local_file');
    expect(classifyLink('./docs')).toBe('local_file');
  });
  it('classifies trailing-slash + anchor as local_file (anchored ref takes precedence)', () => {
    // `docs/#anchor` does not end with `/`, so the directory branch does not
    // fire; the existing anchor-handling branch keeps it as local_file.
    expect(classifyLink('docs/#anchor')).toBe('local_file');
  });
});
