/* eslint-disable security/detect-non-literal-fs-filename */
/**
 * Unit tests for resolveLocalHref — shared href → filesystem path resolution.
 *
 * This utility is used by both the audit (agent-skills) and validate (resources)
 * code paths to consistently handle anchor stripping, URL-decoding, and the
 * RFC 3986 §4.2 absolute-path reference (leading `/`) case.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, normalizePath, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveLocalHref } from '../src/utils.js';

const SOURCE = '/project/docs/README.md';
const SOURCE_DIR = '/project/docs';
const GUIDE_MD = './guide.md';
const FOO_MD_HREF = '/docs/foo.md';
const FOO_MD_REL = 'docs/foo.md';
const EXPECTED_RESOLVED = 'expected resolved';

describe('resolveLocalHref', () => {
  it('resolves a simple relative path to kind=resolved', () => {
    const result = resolveLocalHref(GUIDE_MD, SOURCE);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, GUIDE_MD));
    expect(result.anchor).toBeUndefined();
  });

  it('strips anchor and returns it separately', () => {
    const result = resolveLocalHref('./guide.md#section', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, GUIDE_MD));
    expect(result.anchor).toBe('section');
  });

  it('returns kind=anchor_only for anchor-only links', () => {
    const result = resolveLocalHref('#heading', SOURCE);
    expect(result.kind).toBe('anchor_only');
  });

  it('decodes %20 as space', () => {
    const result = resolveLocalHref('My%20Folder/doc.md', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'My Folder/doc.md'));
    expect(result.anchor).toBeUndefined();
  });

  it('decodes %26 as ampersand', () => {
    const result = resolveLocalHref('Fraud%20%26%20Investigations/CLAUDE.md', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(
      safePath.resolve(SOURCE_DIR, 'Fraud & Investigations/CLAUDE.md'),
    );
    expect(result.anchor).toBeUndefined();
  });

  it('decodes percent-encoding AND strips anchor', () => {
    const result = resolveLocalHref('My%20Folder/doc.md#intro', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'My Folder/doc.md'));
    expect(result.anchor).toBe('intro');
  });

  it('falls back to raw href on invalid percent-encoding', () => {
    const result = resolveLocalHref('bad%ZZencoding.md', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'bad%ZZencoding.md'));
    expect(result.anchor).toBeUndefined();
  });
});

describe('resolveLocalHref leading-/ behavior', () => {
  const PROJECT_ROOT = '/proj';
  const SOURCE_IN_PROJECT = '/proj/docs/sub/page.md';

  it('leading-/ resolves to projectRoot', () => {
    const r = resolveLocalHref(FOO_MD_HREF, SOURCE_IN_PROJECT, PROJECT_ROOT);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(r.resolvedPath).toBe(safePath.resolve(PROJECT_ROOT, FOO_MD_REL));
  });

  it('no leading-/ keeps source-dir-relative behavior even with projectRoot supplied', () => {
    const r = resolveLocalHref('../foo.md', SOURCE_IN_PROJECT, PROJECT_ROOT);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    // /proj/docs/sub/../foo.md → /proj/docs/foo.md
    expect(r.resolvedPath).toBe(safePath.resolve('/proj/docs', 'foo.md'));
  });

  it('leading-/ with no projectRoot returns absolute_no_root', () => {
    const r = resolveLocalHref(FOO_MD_HREF, SOURCE_IN_PROJECT);
    expect(r.kind).toBe('absolute_no_root');
    if (r.kind !== 'absolute_no_root') return;
    expect(r.href).toBe(FOO_MD_HREF);
    expect(r.anchor).toBeUndefined();
  });

  it('preserves anchor across leading-/ resolution', () => {
    const r = resolveLocalHref(`${FOO_MD_HREF}#section`, SOURCE_IN_PROJECT, PROJECT_ROOT);
    if (r.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(r.anchor).toBe('section');
  });

  it('preserves anchor on absolute_no_root', () => {
    const r = resolveLocalHref(`${FOO_MD_HREF}#section`, SOURCE_IN_PROJECT);
    expect(r.kind).toBe('absolute_no_root');
    if (r.kind !== 'absolute_no_root') return;
    expect(r.anchor).toBe('section');
  });

  describe('escape detection (real-filesystem)', () => {
    let projectRoot: string;
    let parentDir: string;
    let sourceFile: string;

    beforeAll(() => {
      // Real tmpdir + real escape target so isWithinProject's realpath check
      // can fire.  Layout:
      //   <parent>/escape.md          (escape target)
      //   <parent>/proj/docs/sub/page.md  (source)
      //   <parent>/proj/badlink       (symlink → external escape.md)
      parentDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-leading-slash-'));
      parentDir = normalizePath(parentDir);
      projectRoot = safePath.join(parentDir, 'proj');
      mkdirSyncReal(safePath.join(projectRoot, 'docs', 'sub'), { recursive: true });
      sourceFile = safePath.join(projectRoot, 'docs', 'sub', 'page.md');
      writeFileSync(sourceFile, '# Source\n');

      const escapeFile = safePath.join(parentDir, 'escape.md');
      writeFileSync(escapeFile, '# Escape\n');

      // Symlink escape: <projectRoot>/badlink → ../escape.md
      symlinkSync(escapeFile, safePath.join(projectRoot, 'badlink'));
    });

    afterAll(() => {
      rmSync(parentDir, { recursive: true, force: true });
    });

    it('leading-/ with .. traversal that escapes projectRoot returns absolute_escapes_root', () => {
      const r = resolveLocalHref('/../escape.md', sourceFile, projectRoot);
      expect(r.kind).toBe('absolute_escapes_root');
      if (r.kind !== 'absolute_escapes_root') return;
      expect(r.href).toBe('/../escape.md');
    });

    it('symlinked escape returns absolute_escapes_root', () => {
      const r = resolveLocalHref('/badlink', sourceFile, projectRoot);
      expect(r.kind).toBe('absolute_escapes_root');
    });

    it('leading-/ that stays within projectRoot resolves cleanly', () => {
      const r = resolveLocalHref('/docs/sub/page.md', sourceFile, projectRoot);
      expect(r.kind).toBe('resolved');
      if (r.kind !== 'resolved') return;
      expect(r.resolvedPath).toBe(sourceFile);
    });
  });
});
