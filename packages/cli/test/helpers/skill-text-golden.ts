/**
 * The skill-text golden corpus (`packages/agent-skills/test/fixtures/skill-text-golden`),
 * written into a project as its capture ran over it: every suite that runs the skills
 * lane over that corpus writes it through here.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';

import { skillDirs } from './skill-text-golden-capture.js';

/** The corpus, with its golden and its capture config. */
export const SKILL_TEXT_GOLDEN_DIR = safePath.resolve(
  resolveFromImportMeta(import.meta.url, '..', '..'),
  '..',
  'agent-skills',
  'test',
  'fixtures',
  'skill-text-golden',
);

/** The golden's description line, as every generated corpus skill carries it. */
const DESCRIPTION = 'description: Pins what the text detectors report for this fixture. It exists only for tests.';

/**
 * The corpus files held in UTF-16LE, line by line, by path. The repository holds
 * no file with a NUL byte (`validate-structure` refuses one), so these are not in
 * the corpus: a project gets them written at run time, the bytes the capture read
 * (a UTF-16LE BOM, then the text in UTF-16LE, LF line endings).
 */
const UTF16LE_FILES: Readonly<Record<string, readonly string[]>> = {
  // A SKILL.md in UTF-16LE: every text detector over its decoded text.
  'enc-utf16/SKILL.md': [
    '---',
    'name: enc-utf16',
    DESCRIPTION,
    'allowed-tools: Bash',
    '---',
    '# Encodings',
    '',
    'Use the Bash tool. As of March 2026 this changed.',
    'Requires `enc:helper-ref` to run. Call `mcp__demo__list_items`.',
    'Then `list_items`.',
    '',
    '```bash',
    'az group list',
    'timeout 5 curl example.test',
    '```',
  ],
  // A linked file in UTF-16LE: the linked-file lane scans its raw UTF-8 reading, as it always has.
  'linked-utf16/references/guide.md': [
    '# Guide',
    '',
    'Call `mcp__srv__get_me` first.',
    'Then call `get_me`.',
    '',
    '```bash',
    'az login',
    '```',
  ],
  // A SKILL.md in UTF-16LE whose prose mentions a bundled file it never links.
  'bundled-mention-utf16/SKILL.md': [
    '---',
    'name: bundled-mention-utf16',
    DESCRIPTION,
    '---',
    '# Bundled mention',
    '',
    'Read references/notes.md before you start.',
  ],
};

/**
 * Write the corpus into `root`: every file but the golden, and each UTF-16LE file
 * byte for byte as the capture read it. The capture config is the caller's to install.
 *
 * @param root - An existing directory
 */
export function writeSkillTextGolden(root: string): void {
  cpSync(SKILL_TEXT_GOLDEN_DIR, root, { recursive: true, filter: (source) => !source.endsWith('golden.json') });
  for (const [path, lines] of Object.entries(UTF16LE_FILES)) {
    const file = safePath.join(root, path);
    mkdirSyncReal(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join('\n')}\n`, 'utf16le')]));
  }
}

/**
 * The project the golden is captured over: the corpus (`writeSkillTextGolden`), its
 * capture config installed as the project config, and a git index.
 *
 * @param dir - Where to make it; created
 * @returns The project root, real
 */
export function writeSkillTextGoldenProject(dir: string): string {
  const root = mkdirSyncReal(dir, { recursive: true });
  writeSkillTextGolden(root);
  cpSync(safePath.join(SKILL_TEXT_GOLDEN_DIR, 'capture.config.yaml'), safePath.join(root, 'vibe-agent-toolkit.config.yaml'));
  execFileSync(gitExecutable(), ['init', '-q'], { cwd: root });
  execFileSync(gitExecutable(), ['add', '-A'], { cwd: root });
  return root;
}

/**
 * The corpus's markdown files in a skill's directory that no link reaches: the
 * bundled-resource check's cases. The skills lane bundles and scans what links
 * reach, so it never scans these.
 */
const UNLINKED_MARKDOWN: ReadonlySet<string> = new Set([
  'bundled-mention/references/notes.md',
  'bundled-mention/references/orphan.md',
  'bundled-mention-utf16/references/notes.md',
  'bundled-mention-utf16/references/orphan.md',
]);

/**
 * The markdown files the skills lane scans in a project holding the corpus, with no
 * store: each skill's SKILL.md (a skill is a top-level directory holding one) and
 * every other markdown file in a skill's directory, each bundled by its skill, but
 * those no link reaches ({@link UNLINKED_MARKDOWN}). A SKILL.md below a skill's top
 * is another skill's definition: the skills include (`*\/SKILL.md`) does not
 * discover it, and a link to it is reported (`LINK_TO_SKILL_DEFINITION`), never
 * bundled, so it is never scanned.
 *
 * @param root - The project
 * @returns The files, root-relative with forward slashes, sorted
 */
export function skillLaneScannedFiles(root: string): string[] {
  const scanned: string[] = [];
  const unlinked = new Set(UNLINKED_MARKDOWN);
  for (const dir of skillDirs(root)) {
    for (const path of readdirSync(safePath.join(root, dir), { recursive: true, encoding: 'utf8' })) {
      const file = toForwardSlash(path);
      const scannedHere = file === 'SKILL.md' || (file.endsWith('.md') && basename(file) !== 'SKILL.md');
      if (!scannedHere) continue;
      // Both ways: every declared unlinked file is in the corpus.
      if (!unlinked.delete(`${dir}/${file}`)) scanned.push(`${dir}/${file}`);
    }
  }
  if (unlinked.size > 0) throw new Error(`declared unlinked markdown the corpus does not hold: ${[...unlinked].join(', ')}`);
  return scanned.sort((a, b) => (a < b ? -1 : Number(a > b)));
}
