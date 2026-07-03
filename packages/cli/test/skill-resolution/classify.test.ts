import { describe, expect, it } from 'vitest';

import { classifyToken, parseSourceSpec } from '../../src/skill-resolution/classify.js';

const SOURCE_SPEC = 'source-spec';
const DEFINITE_PATH = 'definite-path';

describe('parseSourceSpec', () => {
  it('parses vendored / workspace / npm / url / path', () => {
    expect(parseSourceSpec('vendored')).toEqual({ vendored: true });
    expect(parseSourceSpec('workspace:foo')).toEqual({ workspace: 'foo' });
    expect(parseSourceSpec('npm:@scope/s@1.2.3')).toEqual({ npm: '@scope/s@1.2.3' });
    expect(parseSourceSpec('url:https://x/y.zip')).toEqual({ url: 'https://x/y.zip' });
    expect(parseSourceSpec('path:../baz')).toEqual({ path: '../baz' });
  });
  it('rejects unknown kinds and missing values', () => {
    expect(() => parseSourceSpec('bogus:x')).toThrow(/workspace:\|npm:/);
    expect(() => parseSourceSpec('npm:')).toThrow(/missing a value/);
  });
});

describe('classifyToken (disambiguation ladder, pure)', () => {
  it('routes kind-prefixed tokens and vendored to source-spec', () => {
    expect(classifyToken('vendored')).toEqual({ shape: SOURCE_SPEC, source: { vendored: true } });
    expect(classifyToken('npm:@s/x@1')).toEqual({ shape: SOURCE_SPEC, source: { npm: '@s/x@1' } });
    expect(classifyToken('path:./x')).toEqual({ shape: SOURCE_SPEC, source: { path: './x' } });
  });
  it('treats separator / dot / absolute tokens as definite paths', () => {
    expect(classifyToken('./my-skill').shape).toBe(DEFINITE_PATH);
    expect(classifyToken('a/b/c').shape).toBe(DEFINITE_PATH);
    expect(classifyToken('/abs/path').shape).toBe(DEFINITE_PATH);
  });
  it('treats a bare word as an ambiguous bare name', () => {
    expect(classifyToken('my-skill')).toEqual({ shape: 'bare-name', token: 'my-skill' });
  });
});
