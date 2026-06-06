/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExampleSkill } from './packager-test-helpers.js';

describe('packager rewrites links inside bundled HTML resources', () => {
  let projectRoot: string;
  const EXTERNAL_HTML = 'external.html';

  beforeAll(() => {
    projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-packager-html-'));
    // Lay out:
    //   <root>/vibe-agent-toolkit.config.yaml
    //   <root>/skills/example/SKILL.md      (links to page.html)
    //   <root>/skills/example/page.html     (links back to SKILL.md, has a comment)
    mkdirSyncReal(safePath.join(projectRoot, 'skills', 'example'), { recursive: true });

    writeFileSync(
      safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'),
      ['version: 1', ''].join('\n'),
    );
    writeFileSync(
      safePath.join(projectRoot, 'skills', 'example', 'SKILL.md'),
      [
        '---',
        'name: example',
        'description: A test skill that links to an HTML page.',
        '---',
        '# Example',
        '',
        'See [the page](./page.html) and [the external page](./external.html).',
        '',
      ].join('\n'),
    );
    writeFileSync(
      safePath.join(projectRoot, 'skills', 'example', 'page.html'),
      [
        '<!doctype html>',
        '<html>',
        '<head><title>Test</title></head>',
        '<body>',
        '<!-- keep me -->',
        '<a href="./SKILL.md">back</a>',
        '</body>',
        '</html>',
        '',
      ].join('\n'),
    );
    // No source-relative links to rewrite — only an external URL — so this page
    // must round-trip byte-for-byte through the bundler.
    writeFileSync(
      safePath.join(projectRoot, 'skills', 'example', EXTERNAL_HTML),
      [
        '<!doctype html>',
        '<html><body>',
        '<a href="https://example.com/docs">external</a>',
        '<img src="https://example.com/cat.png">',
        '</body></html>',
        '',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rewrites links inside bundled HTML resources', async () => {
    const { outputPath } = await buildExampleSkill(projectRoot);

    // Non-SKILL.md resources land in the 'resources/' subdirectory of the bundle
    const html = readFileSync(safePath.join(outputPath, 'resources', 'page.html'), 'utf-8');

    // HTML comment and surrounding markup is preserved verbatim
    expect(html).toContain('<!-- keep me -->');
    expect(html).toContain('<html>');
    expect(html).toContain('</body>');

    // The source-relative href was rewritten to point at the bundled SKILL.md
    expect(html).toMatch(/href="[^"]*SKILL\.md"/);

    // The original source-relative href is gone (it pointed to the source layout, not the output)
    expect(html).not.toContain('href="./SKILL.md"');
  });

  it('round-trips an HTML resource with no rewritable links byte-for-byte', async () => {
    const { outputPath } = await buildExampleSkill(projectRoot);
    const source = readFileSync(safePath.join(projectRoot, 'skills', 'example', EXTERNAL_HTML), 'utf-8');
    const bundled = readFileSync(safePath.join(outputPath, 'resources', EXTERNAL_HTML), 'utf-8');
    // External-only links resolve to themselves, so the bundler must not touch a byte.
    expect(bundled).toBe(source);
  });
});
