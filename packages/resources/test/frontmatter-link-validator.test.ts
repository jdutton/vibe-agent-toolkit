/* eslint-disable sonarjs/no-duplicate-string, security/detect-non-literal-fs-filename */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateFrontmatterLinks } from '../src/frontmatter-link-validator.js';

describe('validateFrontmatterLinks', () => {
  let projectRoot: string;
  let sourceFile: string;
  let targetFile: string;
  let fragmentsByFile: Map<string, Set<string>>;

  beforeAll(async () => {
    projectRoot = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-fmlv-'));
    await mkdir(safePath.join(projectRoot, 'docs'), { recursive: true });
    sourceFile = safePath.join(projectRoot, 'docs', 'source.md');
    targetFile = safePath.join(projectRoot, 'docs', 'target.md');
    await writeFile(sourceFile, '---\n---\n# Source\n');
    await writeFile(targetFile, '# Target\n\n## Section A\n');

    fragmentsByFile = new Map();
    fragmentsByFile.set(targetFile, new Set(['target', 'section-a']));
    fragmentsByFile.set(sourceFile, new Set(['source']));
  });

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  const refSchema = {
    type: 'object',
    properties: { ref: { type: 'string', format: 'uri-reference' } },
  };

  // Bind the test fixture's common arguments once so each test body shows only
  // what's unique to it. Keeps assertions readable AND avoids structural
  // duplication that SonarCloud flags on new code.
  const run = (
    frontmatter: Record<string, unknown> | undefined,
    schema: object = refSchema,
  ) =>
    validateFrontmatterLinks(frontmatter, schema, sourceFile, fragmentsByFile, {
      projectRoot,
      skipGitIgnoreCheck: true,
    });

  it('returns no issues and no external URLs when path exists', async () => {
    const { issues, externalUrls } = await run({ ref: 'target.md' });
    expect(issues).toEqual([]);
    expect(externalUrls).toEqual([]);
  });

  it('reports frontmatter_link_broken for missing file', async () => {
    const { issues } = await run({ ref: 'missing.md' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('FRONTMATTER_LINK_BROKEN');
    expect(issues[0]?.message).toContain('ref');
    expect(issues[0]?.message).toContain('missing.md');
  });

  it('validates anchor in target file', async () => {
    const ok = await run({ ref: 'target.md#section-a' });
    expect(ok.issues).toEqual([]);

    const bad = await run({ ref: 'target.md#nonexistent' });
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]?.code).toBe('FRONTMATTER_ANCHOR_MISSING');
  });

  it('collects absolute https URLs as externalUrls (no issue emitted)', async () => {
    const { issues, externalUrls } = await run({ ref: 'https://example.com/foo' });
    expect(issues).toEqual([]);
    expect(externalUrls).toHaveLength(1);
    expect(externalUrls[0]).toMatchObject({
      url: 'https://example.com/foo',
      sourcePath: sourceFile,
      dottedPath: 'ref',
    });
  });

  it('skips mailto values silently', async () => {
    const { issues, externalUrls } = await run({ ref: 'mailto:a@b.c' });
    expect(issues).toEqual([]);
    expect(externalUrls).toEqual([]);
  });

  it('emits frontmatter_unknown_link for unknown schemes', async () => {
    const { issues } = await run({ ref: 'tel:+15555550100' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('FRONTMATTER_UNKNOWN_LINK');
    expect(issues[0]?.message).toContain('ref');
  });

  it('emits dotted path in message for nested arrays of objects', async () => {
    const schema = {
      type: 'object',
      properties: {
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { adr: { type: 'string', format: 'uri-reference' } },
          },
        },
      },
    };
    const { issues } = await run({ citations: [{ adr: 'missing.md' }] }, schema);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('citations[0].adr');
  });

  it('returns empty when frontmatter is undefined', async () => {
    const { issues, externalUrls } = await run(undefined);
    expect(issues).toEqual([]);
    expect(externalUrls).toEqual([]);
  });

  describe('leading-/ frontmatter URI-references (RFC 3986 §4.2)', () => {
    it('resolves /docs/target.md against projectRoot', async () => {
      const { issues } = await run({ ref: '/docs/target.md' });
      expect(issues).toEqual([]);
    });

    it('preserves anchor on leading-/ frontmatter reference', async () => {
      const { issues } = await run({ ref: '/docs/target.md#section-a' });
      expect(issues).toEqual([]);
    });

    it('emits frontmatter_link_broken with absolute_no_root message when projectRoot omitted', async () => {
      const { issues } = await validateFrontmatterLinks(
        { ref: '/docs/target.md' },
        refSchema,
        sourceFile,
        fragmentsByFile,
        { skipGitIgnoreCheck: true },
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('FRONTMATTER_LINK_BROKEN');
      expect(issues[0]?.message).toContain('requires a configured projectRoot');
    });

    it('emits frontmatter_link_broken with traversal message on absolute_escapes_root', async () => {
      const { issues } = await run({ ref: '/../escape.md' });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('FRONTMATTER_LINK_BROKEN');
      expect(issues[0]?.message).toContain('escapes the project root via path traversal');
    });
  });
});
