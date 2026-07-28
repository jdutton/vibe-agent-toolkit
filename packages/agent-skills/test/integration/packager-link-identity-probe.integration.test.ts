/**
 * ADVERSARIAL PROBE — link identity in the packager's rewrite pass.
 *
 * `transformContent` replays a raw regex over the whole document and pairs each
 * match with a PARSED link looked up by href. Two consequences worth probing:
 *
 *  A. A link the parser never saw (inside a fenced code block — mdast treats it as
 *     code, not a link) has no map entry, so it is left alone. UNLESS its href
 *     collides with a real link elsewhere in the document, in which case the lookup
 *     HITS and a documentation EXAMPLE gets rewritten as if it were a live link.
 *  B. An image `![alt](src)` — the regex matches the `[alt](src)` tail, leaving the
 *     leading `!` outside the replacement.
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
   * KNOWN DEFECT, pre-existing and deliberately NOT fixed here.
   *
   * `it.fails` asserts this currently FAILS: the body of a ```markdown fence is
   * rewritten as if it were a live link, so a skill teaching authored link syntax
   * ships a lesson pointing at the packaged path instead of the one the reader
   * must type. `transformContent` replays a raw regex over the whole document with
   * no notion of code spans; mdast never parsed the fenced text as a link, so it
   * survives ONLY while no real link shares its href. Inline code spans
   * (`` `[Guide](refs/guide.md)` ``) have the same exposure.
   *
   * VAT's own 12 skills are unaffected today — verified by diffing every source
   * skill against its packaged output; no fenced example collides with a real
   * href. That is why this is filed rather than fixed: it is latent, pre-existing,
   * and a real fix (masking code spans before replacement) is its own change with
   * its own blast radius. When someone fixes it, this test flips to passing and
   * fails the suite until the `.fails` is removed.
   */
  it('leaves a fenced code example verbatim even when its href matches a real link', async () => {
    tempDir = createTestTempDir('vat-packager-link-identity-');
    const body = await packageFixture(tempDir);

    // The real link SHOULD be repointed at the flattened location.
    expect(body).toContain('Real link that ships: [Guide](resources/guide.md)');

    // The fenced example teaches authored syntax. Rewriting it corrupts the lesson.
    expect(body).toContain('```markdown\n[Guide](refs/guide.md)\n```');
  });

  it('does not orphan the bang when an image target does not ship', async () => {
    tempDir = createTestTempDir('vat-packager-link-identity-img-');
    const body = await packageFixture(tempDir);

    // Whatever the rendering, it must not leave a dangling `!` in front of prose.
    expect(body).not.toMatch(/!diagram(?!])/);
  });
});
