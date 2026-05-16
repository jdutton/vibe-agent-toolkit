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
});
