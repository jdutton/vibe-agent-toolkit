/**
 * What a link becomes when its target has NO packaged counterpart.
 *
 * The packager rewrites a link to wherever it moved the target. Three ordinary link
 * shapes have nowhere to move TO, and each one used to render as its own flavour of
 * broken:
 *
 *  1. **A non-markdown asset dropped from the bundle** (`evals/evals.json`). The
 *     resource registry indexes markdown, so an exclude rule matching `filePath`
 *     never sees it; it fell through to the bundled-link rule, whose template
 *     interpolated an undefined `link.resource.relativePath` — shipping `[text]()`,
 *     a syntactically valid markdown link to nowhere.
 *  2. **A directory link written WITHOUT a trailing slash** (`refs`) — classified
 *     `local_file`, same undefined-path outcome, same `[text]()`.
 *  3. **A directory link written WITH one** (`refs/`) — classified `local_directory`,
 *     which matched NO rewrite rule at all and so survived verbatim, pointing at a
 *     directory that does not exist in the output. `checkBrokenPackagedLinks` then
 *     failed the build under `PACKAGED_BROKEN_LINK`, a code whose own remediation
 *     text reads "Report the issue — this indicates a VAT bug."
 *
 * A directory link can never survive packaging: bundled resources are FLATTENED into
 * `resources/`, so no authored directory exists in the output to point at. All three
 * strip to plain text now, which is what an excluded markdown link already did — and
 * what `PACKAGED_TEST_INPUT` has always claimed ("the link is removed from the
 * packaged output") while being true for only one spelling out of three.
 */
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../../../cli/test/system/test-common.js';
import { packageSkill } from '../../src/skill-packager.js';

const SKILL_MD = `---
name: demo
description: Fixture skill covering every spelling of a link whose target may not ship.
---

# demo

- excluded-md: [a](evals/sub/note.md)
- excluded-json: [b](evals/evals.json)
- excluded-dir-slash: [c](evals/)
- excluded-dir-bare: [d](evals)
- kept-md: [e](refs/guide.md)
- kept-dir-slash: [f](refs/)
- kept-dir-bare: [g](refs)
`;

/** Write the skill tree and package it; returns the packaged SKILL.md body. */
async function packageFixture(tempDir: string): Promise<{ body: string; hasErrors: boolean }> {
  const skillDir = safePath.join(tempDir, 'skills', 'demo');
  mkdirSyncReal(safePath.join(skillDir, 'evals', 'sub'), { recursive: true });
  mkdirSyncReal(safePath.join(skillDir, 'refs'), { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), SKILL_MD);
  writeTestFile(safePath.join(skillDir, 'evals', 'evals.json'), '{"expected_output":"KEY"}');
  writeTestFile(safePath.join(skillDir, 'evals', 'sub', 'note.md'), '# note\n');
  writeTestFile(safePath.join(skillDir, 'refs', 'guide.md'), '# guide\n');

  const outputPath = safePath.join(tempDir, 'dist', 'demo');
  const result = await packageSkill(safePath.join(skillDir, 'SKILL.md'), {
    outputPath,
    formats: ['directory'],
    testInputDirs: [safePath.join(skillDir, 'evals')],
  });

  const { readFile } = await import('node:fs/promises');
  return {
    body: await readFile(safePath.join(outputPath, 'SKILL.md'), 'utf-8'),
    hasErrors: result.hasErrors,
  };
}

describe('packaging a link whose target does not ship (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('strips every unpackageable link to plain text and rewrites the one that ships', async () => {
    tempDir = createTestTempDir('vat-packager-unpackaged-link-');
    const { body, hasErrors } = await packageFixture(tempDir);

    // The only link with a packaged counterpart keeps its link syntax, repointed at
    // the flattened `resources/` location.
    expect(body).toContain('- kept-md: [e](resources/guide.md)');

    // Everything else becomes prose. No empty `()` target, no verbatim directory href.
    expect(body).toContain('- excluded-md: a');
    expect(body).toContain('- excluded-json: b');
    expect(body).toContain('- excluded-dir-slash: c');
    expect(body).toContain('- excluded-dir-bare: d');
    expect(body).toContain('- kept-dir-slash: f');
    expect(body).toContain('- kept-dir-bare: g');

    // The two shapes of broken output this guards against, asserted directly so a
    // regression names itself rather than failing one of the `toContain`s above.
    expect(body).not.toContain('()');
    expect(body).not.toContain('(evals/)');
    expect(body).not.toContain('(refs/)');

    // A directory link used to fail the build outright as PACKAGED_BROKEN_LINK.
    expect(hasErrors).toBe(false);
  });
});
