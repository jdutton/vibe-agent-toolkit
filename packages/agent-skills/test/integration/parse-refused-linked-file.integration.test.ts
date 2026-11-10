/**
 * A document the skill links to whose parse the crawl REFUSED is an error, in
 * both skill lanes — never an opaque asset shipped at exit 0.
 *
 * The registry parses every file on the bounded route; a file over a limit is
 * refused and lands in no list but `getParseRefusedResources()`. The link walk
 * then finds it on disk, not in the registry, and treats it as a non-markdown
 * asset: bundled verbatim, its own links never walked, nothing in it checked.
 *
 * The seed is real and cheap: 20,000 links, over the DEFAULT `outputRows` limit
 * (16,384 rows). Neither lane offers a seam for tighter limits, so the default is
 * what a real adopter would hit.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { isVatError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { createTempDir, overOutputRowsMarkdown, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILL_PACKAGING_INPUT_INVALID_CODE } from '../../src/packaging-errors.js';
import { packageSkill } from '../../src/skill-packager.js';
import { activeErrorsOf, validateSkillForPackaging } from '../../src/validators/packaging-validator.js';

const SKILL_MD = `---
name: linker
description: Fixture skill linking one reference document too large to parse within its limits.
---

# linker

See [the reference](reference.md).
`;

/**
 * Over the default `outputRows` (16,384): one link row per line. The nonce makes
 * the content new to the shared parse cache: an in-process parse of the same
 * bytes stores unbounded facts that a later crawl serves as an admission.
 */
const OVER_OUTPUT_ROWS = overOutputRowsMarkdown('SKILL.md');

/** Package the skill; return the rejection's message, asserting it is a packaging input error over the limit. */
async function limitRejectionMessage(tempDir: string, skillPath: string): Promise<string> {
  const outputPath = safePath.join(tempDir, 'out', 'linker');
  const rejection: unknown = await packageSkill(skillPath, { outputPath, formats: ['directory'] }).catch((error: unknown) => error);
  expect(isVatError(rejection, SKILL_PACKAGING_INPUT_INVALID_CODE)).toBe(true);
  const message = (rejection as Error).message;
  expect(message).toContain('RESOURCE_PARSE_LIMIT_EXCEEDED');
  return message;
}

describe('a linked document whose parse the crawl refused (integration)', () => {
  let tempDir: string;
  let skillPath: string;

  beforeEach(() => {
    tempDir = createTempDir('parse-refused-linked-');
    const skillDir = safePath.join(tempDir, 'skills', 'linker');
    mkdirSyncReal(skillDir, { recursive: true });
    // A config marks the project root, so both lanes crawl `tempDir` as the project.
    writeFileSync(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), '{}\n');
    skillPath = safePath.join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, SKILL_MD);
    writeFileSync(safePath.join(skillDir, 'reference.md'), OVER_OUTPUT_ROWS);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('validateSkillForPackaging reports it as RESOURCE_PARSE_LIMIT_EXCEEDED at that document', async () => {
    const result = await validateSkillForPackaging(skillPath);

    const found = activeErrorsOf(result).filter((issue) => issue.code === 'RESOURCE_PARSE_LIMIT_EXCEEDED');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', location: 'skills/linker/reference.md' });
    expect(found[0]?.message).toContain('outputRows');
  });

  it('packageSkill refuses the skill as a packaging input error naming the document, and writes nothing', async () => {
    expect(await limitRejectionMessage(tempDir, skillPath)).toContain('reference.md');
  });

  // A bundled asset the crawl never enumerated (HTML is outside its include) is
  // admitted by the packager's own `addResource`, which throws the refusal: it
  // escaped as a raw `ParseLimitError`, no skill named and no remedy.
  it('packageSkill refuses a bundled HTML asset over a parse limit as a packaging input error naming it', async () => {
    const page = `<!-- ${randomUUID()} -->\n${'<a href="./SKILL.md">l</a>\n'.repeat(20_000)}`;
    writeFileSync(safePath.join(tempDir, 'skills', 'linker', 'reference.md'), '# Reference\n\nSee [the page](page.html).\n');
    writeFileSync(safePath.join(tempDir, 'skills', 'linker', 'page.html'), page);

    const message = await limitRejectionMessage(tempDir, skillPath);
    expect(message).toContain('skills/linker/page.html');
    expect(message).toContain('outputRows');
  });

  // The in-process sibling: the packager parses SKILL.md on this thread, and a
  // frontmatter nested past the stack escaped as `yaml`'s raw `YAMLParseError`.
  it('packageSkill refuses a SKILL.md whose frontmatter overflows the parse as a packaging input error', async () => {
    const depth = 50_000;
    writeFileSync(skillPath, `---\nname: linker\nnested: ${'['.repeat(depth)}${']'.repeat(depth)}\n---\n# linker\n`);

    await limitRejectionMessage(tempDir, skillPath);
  });
});
