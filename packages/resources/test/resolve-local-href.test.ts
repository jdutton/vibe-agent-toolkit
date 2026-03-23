/**
 * Unit tests for resolveLocalHref — shared href → filesystem path resolution.
 *
 * This utility is used by both the audit (agent-skills) and validate (resources)
 * code paths to consistently handle anchor stripping and URL-decoding.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveLocalHref } from '../src/utils.js';

const SOURCE = '/project/docs/README.md';
const SOURCE_DIR = '/project/docs';
const GUIDE_MD = './guide.md';

describe('resolveLocalHref', () => {
  it('should resolve a simple relative path', () => {
    const result = resolveLocalHref(GUIDE_MD, SOURCE);
    expect(result).toEqual({
      resolvedPath: resolve(SOURCE_DIR, GUIDE_MD),
      anchor: undefined,
    });
  });

  it('should strip anchor and return it separately', () => {
    const result = resolveLocalHref('./guide.md#section', SOURCE);
    expect(result).toEqual({
      resolvedPath: resolve(SOURCE_DIR, GUIDE_MD),
      anchor: 'section',
    });
  });

  it('should return null for anchor-only links', () => {
    expect(resolveLocalHref('#heading', SOURCE)).toBeNull();
  });

  it('should decode %20 as space', () => {
    const result = resolveLocalHref('My%20Folder/doc.md', SOURCE);
    expect(result).toEqual({
      resolvedPath: resolve(SOURCE_DIR, 'My Folder/doc.md'),
      anchor: undefined,
    });
  });

  it('should decode %26 as ampersand', () => {
    const result = resolveLocalHref('Fraud%20%26%20Investigations/CLAUDE.md', SOURCE);
    expect(result).toEqual({
      resolvedPath: resolve(SOURCE_DIR, 'Fraud & Investigations/CLAUDE.md'),
      anchor: undefined,
    });
  });

  it('should decode percent-encoding AND strip anchor', () => {
    const result = resolveLocalHref('My%20Folder/doc.md#intro', SOURCE);
    expect(result).toEqual({
      resolvedPath: resolve(SOURCE_DIR, 'My Folder/doc.md'),
      anchor: 'intro',
    });
  });

  it('should fall back to raw href on invalid percent-encoding', () => {
    const result = resolveLocalHref('bad%ZZencoding.md', SOURCE);
    expect(result).toEqual({
      resolvedPath: resolve(SOURCE_DIR, 'bad%ZZencoding.md'),
      anchor: undefined,
    });
  });
});
