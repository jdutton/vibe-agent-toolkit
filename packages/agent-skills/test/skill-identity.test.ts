import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { withSyncFsRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDeclaredSkillName } from '../src/skill-identity.js';


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

  it('returns the declared name', () => {
    const path = writeSkillMd(tempDir, 'plain', 'name: pdf-processor\ndescription: Reads PDFs.');
    expect(readDeclaredSkillName(path)).toBe('pdf-processor');
  });

  it('unquotes a YAML-quoted name', () => {
    // A hand-rolled `^name:\s*(.+)$` regex returns `"pdf-processor"` here,
    // quotes included — which is why this goes through the YAML parser.
    const path = writeSkillMd(tempDir, 'quoted', 'name: "pdf-processor"\ndescription: Reads PDFs.');
    expect(readDeclaredSkillName(path)).toBe('pdf-processor');
  });

  it('ignores a name-like line in the body', () => {
    const path = writeSkillMdRaw(tempDir, 'body-only', '# Heading\n\nname: not-the-name\n');
    expect(readDeclaredSkillName(path)).toBeUndefined();
  });

  it('returns undefined for a blank name', () => {
    const path = writeSkillMd(tempDir, 'blank', 'name: "   "\ndescription: Blank.');
    expect(readDeclaredSkillName(path)).toBeUndefined();
  });

  it('returns undefined for a non-string name', () => {
    const path = writeSkillMd(tempDir, 'numeric', 'name: 42\ndescription: Numeric.');
    expect(readDeclaredSkillName(path)).toBeUndefined();
  });

  it('returns undefined when the file does not exist', () => {
    expect(readDeclaredSkillName(safePath.join(tempDir, 'nope', 'SKILL.md'))).toBeUndefined();
  });

  it('returns undefined when a path component is a file (ENOTDIR is absence too)', () => {
    const path = writeSkillMd(tempDir, 'file-as-dir', 'name: x\ndescription: y.');
    expect(readDeclaredSkillName(safePath.join(path, 'SKILL.md'))).toBeUndefined();
  });

  it('rethrows a refused read instead of reporting the skill as nameless', async () => {
    // `undefined` means "declares no usable name"; a permission refusal has not
    // established that, and a caller falling back to the directory leaf would
    // then rename the skill on the operator's behalf.
    const path = writeSkillMd(tempDir, 'refused', 'name: pdf-processor\ndescription: Reads PDFs.');
    await withSyncFsRefused('readFileSync', path, 'EACCES', () => {
      expect(() => readDeclaredSkillName(path)).toThrow(/EACCES/);
    });
  });
});
