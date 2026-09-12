/**
 * ADVERSARIAL PROBE — link identity in the packager's rewrite pass.
 *
 * Both hazards below came from `transformContent` replaying a raw regex over the
 * whole document and pairing each match with a PARSED link looked up by href:
 *
 *  A. A link the parser never saw (inside a fenced code block — mdast treats it as
 *     code, not a link) has no map entry, so it is left alone. UNLESS its href
 *     collides with a real link elsewhere in the document, in which case the lookup
 *     HITS and a documentation EXAMPLE gets rewritten as if it were a live link.
 *  B. An image `![alt](src)` — the regex matches the `[alt](src)` tail, leaving the
 *     leading `!` outside the replacement.
 *
 * ✅ **The href correlation is gone.** `transformContent` now splices each parsed
 * link at its own `[startOffset, endOffset)` span, so hazard A cannot arise
 * structurally: mdast yields no link node inside code, so a fenced or code-span
 * example is never a splice target and no href can make it one. These probes stay
 * because they assert the OUTCOME rather than the mechanism — an outcome the
 * packager must keep whatever the rewriter is built from next.
 */
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../../../cli/test/system/test-common.js';
import { packageSkill } from '../../src/skill-packager.js';

const SKILL_MD = `---
name: probe
description: Fixture probing how link identity behaves for code fences and images.
---

# probe

Real link that ships: [Guide](refs/guide.md)

Teaching the syntax, which must survive VERBATIM:

\`\`\`markdown
[Guide](refs/guide.md)
\`\`\`

Image whose target does not ship: ![diagram](evals/diagram.png)

Image inside a link, which must repoint the OUTER href: [![alt](refs/guide.md)](refs/guide.md)
`;

async function packageFixture(tempDir: string): Promise<string> {
  const skillDir = safePath.join(tempDir, 'skills', 'probe');
  mkdirSyncReal(safePath.join(skillDir, 'refs'), { recursive: true });
  mkdirSyncReal(safePath.join(skillDir, 'evals'), { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), SKILL_MD);
  writeTestFile(safePath.join(skillDir, 'refs', 'guide.md'), '# guide\n');
  writeTestFile(safePath.join(skillDir, 'evals', 'diagram.png'), 'not-really-a-png');

  const outputPath = safePath.join(tempDir, 'dist', 'probe');
  await packageSkill(safePath.join(skillDir, 'SKILL.md'), {
    outputPath,
    formats: ['directory'],
    testInputDirs: [safePath.join(skillDir, 'evals')],
  });

  const { readFile } = await import('node:fs/promises');
  return readFile(safePath.join(outputPath, 'SKILL.md'), 'utf-8');
}

describe('link identity probe (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  /**
   * ✅ FIXED — this was an `it.fails` pinning a known defect, and it now passes.
   *
   * The defect: the body of a ```markdown fence was rewritten as if it were a live
   * link, so a skill teaching authored link syntax shipped a lesson pointing at the
   * packaged path instead of the one the reader must type. It survived ONLY while
   * no real link shared its href, and inline code spans had the same exposure.
   *
   * It was closed twice over, and the second close is the durable one. First by
   * masking code ranges before replacement (`codeSpanRanges`), which made the skip
   * intentional rather than accidental. Then by `transformContent` becoming
   * span-driven: mdast parses fenced text as a `code` node, never a link, so a
   * fenced example is not a splice target at all and no href collision can make it
   * one. The masking is retained for the residual regex fallback.
   */
  it('leaves a fenced code example verbatim even when its href matches a real link', async () => {
    tempDir = createTestTempDir('vat-packager-link-identity-');
    const body = await packageFixture(tempDir);

    // The real link SHOULD be repointed at the flattened location.
    expect(body).toContain('Real link that ships: [Guide](resources/guide.md)');

    // The fenced example teaches authored syntax. Rewriting it corrupts the lesson.
    expect(body).toContain('```markdown\n[Guide](refs/guide.md)\n```');
  });

  /**
   * 🚨 The test that would have caught the span rewrite being INERT HERE.
   *
   * `transformContent` splices each link at its parsed span instead of replaying
   * a regex and correlating on href — the fix for `[![alt](img)](url)`, where the
   * regex matches the INNER image's href and the lookup misses. Every unit test
   * of that fix passed while the packager, the only production caller, still
   * shipped the bug: it passed the frontmatter-STRIPPED body together with
   * WHOLE-FILE offsets, so every span was off by the frontmatter length and every
   * splice quietly declined to the old path.
   *
   * ⇒ A unit test of a fix is not a test that the fix REACHES the caller. This
   * one runs the real packager end to end.
   */
  it('repoints the outer href when an image sits inside a link', async () => {
    tempDir = createTestTempDir('vat-packager-link-identity-nested-');
    const body = await packageFixture(tempDir);

    // The OUTER destination is repointed at the flattened location, and the
    // inner image is re-emitted verbatim inside the link text.
    expect(body).toContain('[![alt](refs/guide.md)](resources/guide.md)');
    // 🪤 The exact shape the OLD regex path produced, which is what this pins.
    // An earlier version of this line excluded `[![alt](refs/guide.md)](refs/guide.md)`
    // — the wholly-unrewritten construct — and was VACUOUS: that string never
    // appears either way, because without the fix the regex replay matches the
    // INNER image href and rewrites THAT, leaving the outer href authored.
    // Simulated with and without the re-base, this assertion is the one that
    // separates them.
    expect(body).not.toContain('[![alt](resources/guide.md)](refs/guide.md)');
  });

  it('does not orphan the bang when an image target does not ship', async () => {
    tempDir = createTestTempDir('vat-packager-link-identity-img-');
    const body = await packageFixture(tempDir);

    // Whatever the rendering, it must not leave a dangling `!` in front of prose.
    expect(body).not.toMatch(/!diagram(?!])/);
  });
});
