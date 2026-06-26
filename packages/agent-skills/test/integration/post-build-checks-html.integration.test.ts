/**
 * Integration tests: post-build checks cover HTML/HTM files.
 *
 * Regression tests for the gap where checkBrokenPackagedLinks and
 * checkUnreferencedFiles hard-filtered to .md, causing broken links
 * INSIDE bundled HTML to ship with a green build.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkBrokenPackagedLinks, checkUnreferencedFiles } from '../../src/post-build-checks.js';

const PACKAGED_BROKEN_LINK = 'PACKAGED_BROKEN_LINK';
const PACKAGED_UNREFERENCED_FILE = 'PACKAGED_UNREFERENCED_FILE';
const RESOURCES_DIR = 'resources';

/** Write SKILL.md at outputDir root linking to the given relative path. */
function writeSkillMd(outputDir: string, linkTarget: string): void {
  writeFileSync(safePath.join(outputDir, 'SKILL.md'), [
    '---',
    'name: test',
    'description: A test skill for post-build HTML checks.',
    '---',
    '# Test',
    '',
    `See [the page](./${linkTarget}).`,
    '',
  ].join('\n'));
}

/** Minimal HTML page content with a single <a href> link. */
function htmlPage(href: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<body>',
    `<a href="${href}">link</a>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

describe('post-build checks: HTML/HTM file support', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-post-build-html-'));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  describe('checkBrokenPackagedLinks', () => {
    it('reports PACKAGED_BROKEN_LINK for a broken <a href> inside a bundled HTML file', async () => {
      // Arrange: SKILL.md → resources/page.html → ./missing.html (absent from output)
      mkdirSyncReal(safePath.join(outputDir, RESOURCES_DIR), { recursive: true });
      writeSkillMd(outputDir, `${RESOURCES_DIR}/page.html`);
      writeFileSync(
        safePath.join(outputDir, RESOURCES_DIR, 'page.html'),
        htmlPage('./missing.html'),
      );
      // missing.html intentionally absent — the link inside page.html is broken.

      // Act
      const issues = await checkBrokenPackagedLinks(outputDir);

      // Assert: HTML file is checked and the broken link is reported as an error
      expect(issues.map(i => i.code)).toContain(PACKAGED_BROKEN_LINK);
      expect(issues.find(i => i.code === PACKAGED_BROKEN_LINK)?.severity).toBe('error');
    });

    it('does not report PACKAGED_BROKEN_LINK for a valid link inside a bundled HTML file', async () => {
      // Arrange: page.html links to sibling.html which exists in the output
      mkdirSyncReal(safePath.join(outputDir, RESOURCES_DIR), { recursive: true });
      writeSkillMd(outputDir, `${RESOURCES_DIR}/page.html`);
      writeFileSync(
        safePath.join(outputDir, RESOURCES_DIR, 'page.html'),
        htmlPage('./sibling.html'),
      );
      writeFileSync(
        safePath.join(outputDir, RESOURCES_DIR, 'sibling.html'),
        '<!doctype html><html><body><p>sibling</p></body></html>\n',
      );

      // Act
      const issues = await checkBrokenPackagedLinks(outputDir);

      // Assert: valid HTML links produce no broken-link issue
      expect(issues.filter(i => i.code === PACKAGED_BROKEN_LINK)).toHaveLength(0);
    });
  });

  describe('checkUnreferencedFiles', () => {
    it('does not report PACKAGED_UNREFERENCED_FILE for HTML file linked only from another HTML file', async () => {
      // Arrange: SKILL.md → resources/page.html → resources/linked-page.html
      // linked-page.html is NOT directly linked from SKILL.md; only reachable via HTML traversal.
      mkdirSyncReal(safePath.join(outputDir, RESOURCES_DIR), { recursive: true });
      writeSkillMd(outputDir, `${RESOURCES_DIR}/page.html`);
      writeFileSync(
        safePath.join(outputDir, RESOURCES_DIR, 'page.html'),
        htmlPage('./linked-page.html'),
      );
      writeFileSync(
        safePath.join(outputDir, RESOURCES_DIR, 'linked-page.html'),
        '<!doctype html><html><body><p>Content only reachable through page.html.</p></body></html>\n',
      );

      // Act
      const issues = await checkUnreferencedFiles(outputDir);

      // Assert: traversal follows HTML <a href> links so linked-page.html is NOT unreferenced
      const unreferencedLocations = issues
        .filter(i => i.code === PACKAGED_UNREFERENCED_FILE)
        .map(i => i.location);
      expect(unreferencedLocations).not.toContain(`${RESOURCES_DIR}/linked-page.html`);
    });
  });
});
