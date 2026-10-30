/**
 * The ONE rule for where a skill ZIP keeps its `SKILL.md`, decided from the entry list alone:
 * at the top level, or directly inside the archive's single top-level folder (what compressing a
 * folder in Finder or Explorer makes). Every verb that takes a skill ZIP reads this answer.
 */
import { describe, expect, it } from 'vitest';

import { skillZipLayout, type SkillZipEntry } from '../src/skill-zip-layout.js';

const file = (name: string): SkillZipEntry => ({ name, kind: 'file' });
const dir = (name: string): SkillZipEntry => ({ name, kind: 'directory' });

describe('skillZipLayout', () => {
  it.each<[string, SkillZipEntry[], string]>([
    ['SKILL.md at the top level', [file('SKILL.md'), file('references/a.md')], ''],
    ['SKILL.md at the top level beside folders that hold their own', [file('SKILL.md'), file('examples/demo/SKILL.md')], ''],
    ['one top-level folder with SKILL.md directly inside', [dir('my-skill/'), file('my-skill/SKILL.md'), file('my-skill/references/a.md')], 'my-skill'],
    ['one top-level folder the archive only implies', [file('my-skill/SKILL.md')], 'my-skill'],
    ['a folder spelled with backslashes, as a ZIP written on Windows may', [file(String.raw`my-skill\SKILL.md`)], 'my-skill'],
    ['a `./` prefix', [file('./SKILL.md')], ''],
    // What macOS adds beside a folder it compresses is not a second top-level entry of the skill.
    ['one folder beside the `__MACOSX` folder Finder adds', [file('my-skill/SKILL.md'), file('__MACOSX/my-skill/._SKILL.md')], 'my-skill'],
    ['one folder beside a top-level `.DS_Store`', [file('my-skill/SKILL.md'), file('.DS_Store')], 'my-skill'],
  ])('accepts %s', (_what, entries, root) => {
    expect(skillZipLayout(entries)).toEqual({ root });
  });

  it.each<[string, SkillZipEntry[], RegExp]>([
    ['no SKILL.md at all', [file('readme.txt')], /holds no SKILL\.md/],
    ['nothing', [], /holds no SKILL\.md/],
    ['SKILL.md two folders down', [file('outer/my-skill/SKILL.md')], /holds no SKILL\.md at its top level.*`outer\/my-skill\/SKILL\.md`/s],
    ['two top-level folders, one holding SKILL.md', [file('my-skill/SKILL.md'), file('other/readme.md')], /`my-skill\/SKILL\.md`.*beside other top-level entries \(other\)/s],
    ['a top-level folder with SKILL.md beside a top-level file', [file('my-skill/SKILL.md'), file('LICENSE')], /beside other top-level entries \(LICENSE\)/],
    ['two skills side by side', [file('a/SKILL.md'), file('b/SKILL.md')], /beside other top-level entries/],
    ['a DIRECTORY named SKILL.md', [dir('SKILL.md/'), file('SKILL.md/x')], /holds no SKILL\.md/],
    ['skill.md in another letter case', [file('skill.md')], /holds no SKILL\.md/],
  ])('refuses %s', (_what, entries, why) => {
    const layout = skillZipLayout(entries);

    expect(layout).toHaveProperty('refused');
    expect('refused' in layout ? layout.refused : '').toMatch(why);
  });
});
