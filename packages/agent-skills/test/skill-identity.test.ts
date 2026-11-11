import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { isPerRunParseRefusal } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { withSyncFsRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { declaredSkillNameIn, readDeclaredSkillName } from '../src/skill-identity.js';

import { setupParseRoute } from './test-helpers.js';

/** Nested past the worker's depth limit, so its parse is refused for the run. */
const DEEP_SKILL = `---\nname: deep\nnested: ${'['.repeat(50_000)}${']'.repeat(50_000)}\n---\n# Deep\n`;

/** Every parse in this file runs in the bounded worker, on one dispatcher. */
const ROUTE = setupParseRoute();

/** Write a SKILL.md with the given raw content under `parent/caseName/`. */
function writeSkillMdRaw(parent: string, caseName: string, content: string): string {
  const dir = safePath.join(parent, caseName);
  mkdirSyncReal(dir, { recursive: true });
  const skillMd = safePath.join(dir, 'SKILL.md');
  writeFileSync(skillMd, content, 'utf-8');
  return skillMd;
}

/** Write a SKILL.md whose frontmatter block is the given YAML. */
function writeSkillMd(parent: string, caseName: string, frontmatter: string): string {
  return writeSkillMdRaw(parent, caseName, `---\n${frontmatter}\n---\n\n# Body\n`);
}

describe('readDeclaredSkillName', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-skill-identity-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the declared name', async () => {
    const path = writeSkillMd(tempDir, 'plain', 'name: pdf-processor\ndescription: Reads PDFs.');
    expect(await readDeclaredSkillName(path, ROUTE)).toBe('pdf-processor');
  });

  it('unquotes a YAML-quoted name', async () => {
    // A hand-rolled `^name:\s*(.+)$` regex returns `"pdf-processor"` here,
    // quotes included — which is why this goes through the YAML parser.
    const path = writeSkillMd(tempDir, 'quoted', 'name: "pdf-processor"\ndescription: Reads PDFs.');
    expect(await readDeclaredSkillName(path, ROUTE)).toBe('pdf-processor');
  });

  it('ignores a name-like line in the body', async () => {
    const path = writeSkillMdRaw(tempDir, 'body-only', '# Heading\n\nname: not-the-name\n');
    expect(await readDeclaredSkillName(path, ROUTE)).toBeUndefined();
  });

  it('returns undefined for a blank name', async () => {
    const path = writeSkillMd(tempDir, 'blank', 'name: "   "\ndescription: Blank.');
    expect(await readDeclaredSkillName(path, ROUTE)).toBeUndefined();
  });

  it('returns undefined for a non-string name', async () => {
    const path = writeSkillMd(tempDir, 'numeric', 'name: 42\ndescription: Numeric.');
    expect(await readDeclaredSkillName(path, ROUTE)).toBeUndefined();
  });

  it('returns undefined when the file does not exist', async () => {
    expect(await readDeclaredSkillName(safePath.join(tempDir, 'nope', 'SKILL.md'), ROUTE)).toBeUndefined();
  });

  it('returns undefined when a path component is a file (ENOTDIR is absence too)', async () => {
    const path = writeSkillMd(tempDir, 'file-as-dir', 'name: x\ndescription: y.');
    expect(await readDeclaredSkillName(safePath.join(path, 'SKILL.md'), ROUTE)).toBeUndefined();
  });

  it('rethrows a refused read instead of reporting the skill as nameless', async () => {
    // `undefined` means "declares no usable name"; a permission refusal has not
    // established that, and a caller falling back to the directory leaf would
    // then rename the skill on the operator's behalf.
    const path = writeSkillMd(tempDir, 'refused', 'name: pdf-processor\ndescription: Reads PDFs.');
    await withSyncFsRefused('readFileSync', path, 'EACCES', async () => {
      await expect(readDeclaredSkillName(path, ROUTE)).rejects.toThrow(/EACCES/);
    });
  });
  it('rethrows a parse the worker refused instead of reporting the skill as nameless', async () => {
    // A refusal declares nothing THIS run could read; `undefined` would send a
    // caller to its fallback (the directory leaf) and rename the skill.
    const path = writeSkillMdRaw(tempDir, 'parse-refused', DEEP_SKILL);
    const thrown: unknown = await readDeclaredSkillName(path, ROUTE).then(() => undefined, (error: unknown) => error);
    expect(isPerRunParseRefusal(thrown)).toBe(true);
    const fromBytes: unknown = await declaredSkillNameIn(DEEP_SKILL, ROUTE).then(() => undefined, (error: unknown) => error);
    expect(isPerRunParseRefusal(fromBytes)).toBe(true);
  });
});
