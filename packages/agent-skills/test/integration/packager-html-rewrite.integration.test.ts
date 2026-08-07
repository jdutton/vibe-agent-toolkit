/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

/**
 * The one route on which an HTML file really does miss the registry.
 *
 * The project registry crawls markdown only, but a bundled HTML file is added
 * to it on demand by `registerBundledAssets` — which is why rewriting works
 * above. That add can FAIL, and the losing file then takes the copy-verbatim
 * fallback with its links intact.
 *
 * ⛔ It cannot fail the way the code's comments used to claim. Both said the
 * collision was with "a same-named markdown file" (`config.yaml` + `config.md`,
 * `page.html` + `page.md`) — but `generateIdFromPath` appends the extension, so
 * `page.md` is `page-md` and `page.html` is `page-html` and they never meet.
 * The reachable collision is a PATH-SLUG one: `a-b/c.html` and `a/b-c.html`
 * both flatten to `a-b-c-html`. That is the fixture below, and it is the same
 * shape as the trap corpus's `dup-hyphen/note.md` vs `dup/hyphen-note.md`.
 */
describe('an HTML file that loses a resource-id collision', () => {
  let projectRoot: string;
  const stderr: string[] = [];
  /** Arrives first, so it takes the shared id. */
  const WINNER_REL = 'a-b/c.html';
  /** Arrives second, loses, and is copied verbatim. */
  const LOSER_REL = 'a/b-c.html';

  beforeAll(() => {
    projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-packager-html-collide-'));
    const skillDir = safePath.join(projectRoot, 'skills', 'example');
    mkdirSyncReal(safePath.join(skillDir, 'a-b'), { recursive: true });
    mkdirSyncReal(safePath.join(skillDir, 'a'), { recursive: true });
    writeFileSync(safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: example',
        'description: A test skill whose two HTML pages flatten to one resource id.',
        '---',
        '# Example',
        '',
        `See [first](./${WINNER_REL}) and [second](./${LOSER_REL}).`,
        '',
      ].join('\n'),
    );
    for (const rel of [WINNER_REL, LOSER_REL]) {
      writeFileSync(
        safePath.join(skillDir, rel),
        '<html><body><a href="../SKILL.md">back</a></body></html>\n',
      );
    }
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the file that won the id, rather than guessing at a cause', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    await buildExampleSkill(projectRoot);
    vi.restoreAllMocks();

    const verbatim = stderr.filter(line => line.includes('verbatim without link rewriting'));
    expect(verbatim, 'expected the verbatim-copy diagnostic to fire').toHaveLength(1);
    expect(verbatim[0]).toContain('lost a resource-id collision to');
    // The winner is named by path, so the author has a file to open.
    expect(verbatim[0]).toContain(WINNER_REL);
    // And the discarded guess — a cause this code could not observe, and which
    // the id scheme makes impossible anyway — is gone.
    expect(verbatim[0]).not.toContain('typically');
  });

  it('copies the losing HTML verbatim, links unrewritten', async () => {
    const { outputPath } = await buildExampleSkill(projectRoot);
    const bundled = readFileSync(safePath.join(outputPath, 'resources', 'b-c.html'), 'utf-8');
    // Not rewritten — that is the behaviour the diagnostic exists to announce.
    expect(bundled).toContain('href="../SKILL.md"');
  });
});
