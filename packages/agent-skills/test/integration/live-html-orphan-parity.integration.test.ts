/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, resetProjectRootCaches, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';

// ---------------------------------------------------------------------------
// AC2 (issue #129): the live audit/validate path crawls HTML, not just
// markdown, so HTML links are walked and HTML broken links surface at source
// time — extraction parity with the built path. These tests build a real skill
// directory and run validateSkillForPackaging (the live path) over it.
// ---------------------------------------------------------------------------

const SKILL_NAME = 'html-parity-probe';
const SKILL_DESC =
  'Integration harness proving the live validate path crawls and walks HTML links at source time.';

let tmpRoot: string;
let counter = 0;

function freshDir(): string {
  counter += 1;
  const dir = safePath.join(normalizedTmpdir(), `vat-html-parity-${process.pid}-${counter}`);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

function skillFrontmatter(body: string): string {
  return ['---', `name: ${SKILL_NAME}`, `description: ${SKILL_DESC}`, '---', '', body, ''].join('\n');
}

beforeEach(() => {
  resetProjectRootCaches();
  tmpRoot = freshDir();
});

afterEach(() => {
  resetProjectRootCaches();
});

describe('live path HTML link parity (AC2)', () => {
  it('walks an HTML reference and reports a broken link INSIDE the HTML at source time', async () => {
    const skillDir = safePath.join(tmpRoot, SKILL_NAME);
    mkdirSyncReal(skillDir, { recursive: true });
    const skillPath = safePath.join(skillDir, 'SKILL.md');

    // SKILL.md → guide.html (valid HTML asset) → missing.md (broken, inside HTML)
    writeFileSync(skillPath, skillFrontmatter('See the [guide](guide.html).'));
    writeFileSync(
      safePath.join(skillDir, 'guide.html'),
      '<html><body><a href="missing.md">missing</a></body></html>\n',
    );

    const result = await validateSkillForPackaging(skillPath);
    const codes = result.allErrors.map(i => i.code);

    // The HTML file's broken local link is detected via the widened crawl.
    expect(codes).toContain('LINK_MISSING_TARGET');
    const missing = result.allErrors.find(i => i.code === 'LINK_MISSING_TARGET');
    expect(missing?.message).toContain('missing.md');
  });

  it('does NOT report a broken link when the HTML reference resolves', async () => {
    const skillDir = safePath.join(tmpRoot, SKILL_NAME);
    mkdirSyncReal(skillDir, { recursive: true });
    const skillPath = safePath.join(skillDir, 'SKILL.md');

    writeFileSync(skillPath, skillFrontmatter('See the [guide](guide.html).'));
    writeFileSync(
      safePath.join(skillDir, 'guide.html'),
      '<html><body><a href="ref.md">ref</a></body></html>\n',
    );
    writeFileSync(safePath.join(skillDir, 'ref.md'), '# Ref\n');

    const result = await validateSkillForPackaging(skillPath);
    const codes = result.allErrors.map(i => i.code);
    expect(codes).not.toContain('LINK_MISSING_TARGET');
    expect(codes).not.toContain('PACKAGED_BROKEN_LINK');
  });
});
