/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/* eslint-disable sonarjs/file-permissions -- `chmod 000` on a throwaway temp path IS the fixture:
   these cases prove the two compat lanes stay honest over a path the filesystem refuses, and
   there is no way to produce one without setting the mode. Everything is under `mkdtemp` and
   restored before removal. */

/**
 * `vat audit --compat --settings` over a plugin the run could not fully read
 * says so, in BOTH blocks, at exit 0 — never silence.
 *
 * 🚨 One unreadable SKILL.md (or one unlistable skill directory) made the
 * compat ANALYZER throw, and the catch around it was `logger.debug` plus no
 * `compatibility:` block and no `settings:` block for that plugin at all — the
 * settings check, which does not depend on the analyzer, never ran. The
 * operator asked two questions and got no answer to either, with the reason
 * visible only under `--debug`. The readable sibling declaring a denied tool
 * was never compared. The first fix made that `compatibility: { analyzed:
 * false }` for the whole plugin; the analyzer now reads every file it can and
 * names the refused one under its own `unchecked`, so BOTH blocks carry a
 * verdict over the readable sibling and name the same refused path.
 *
 * 🚨 And a skill reached through a SYMLINK was silently outside the settings
 * check's population (`Dirent.isFile()`/`isDirectory()` are both false for a
 * link) while the validator lane read it and reported its `allowed-tools` in
 * the same document: `CAPABILITY_LOCAL_SHELL` on `skills/linked/SKILL.md`
 * beside `settings: compatible: true` under a `deny: ["Bash"]`.
 *
 * Every case here carries a readable `plain` skill that declares the denied
 * tool, so "degraded honestly" is distinguishable from "reported nothing".
 */

import fs from 'node:fs';

import { createSymlink, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditWithSettings,
  bashConflictFiles,
  bashSkill,
  writeDenyBashSettings,
  writeSettingsPlugin,
} from './audit-settings-fixture.js';

/** `chmod 000` denies nothing to uid 0 and nothing on Windows. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const PLAIN_SKILL = 'skills/plain/SKILL.md';
const LINKED_DIR = 'linked-dir';
const LINKED_FILE = 'linked-file';

let tempDir: string;
let settingsFile: string;
const restoreModes: string[] = [];

beforeAll(() => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-settings-unreachable-'));
  settingsFile = writeDenyBashSettings(tempDir);
});

afterAll(() => {
  // Restore modes FIRST: `rm -rf` cannot remove a 000 directory's contents.
  for (const p of restoreModes) if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(CANNOT_DENY_READS)('vat audit --compat --settings over a plugin with an unreadable path', () => {
  it.each([
    ['SKILL.md', 'lockedfile', (dir: string) => safePath.join(dir, 'skills', 'lockedfile', 'SKILL.md'), 'skills/lockedfile/SKILL.md'],
    ['skill directory', 'locked', (dir: string) => safePath.join(dir, 'skills', 'locked'), 'skills/locked'],
  ])('an unreadable %s: both blocks present, the sibling checked, the refused path listed unchecked, exit 0', (_kind, name, lock, expectedUnchecked) => {
    const pluginDir = writeSettingsPlugin(tempDir, `locked-${name}`, { plain: bashSkill('plain'), [name]: bashSkill(name) });
    const locked = lock(pluginDir);
    fs.chmodSync(locked, 0o000);
    restoreModes.push(locked);

    const { exit, stderr, plugin } = auditWithSettings(pluginDir, settingsFile);

    expect(exit).toBe(0);
    // The analyzer analyzed everything it could read: the readable sibling's
    // `allowed-tools: Bash` is observed, and the refused path is named under
    // `compatibility.unchecked` — not the whole plugin reported `analyzed: false`
    // for one file, which is the analyzer's answer only to a plugin-wide failure.
    expect(plugin?.compatibility?.analyzed).toBeUndefined();
    expect(plugin?.compatibility?.observations?.map((o) => o.code)).toContain('CAPABILITY_LOCAL_SHELL');
    expect(plugin?.compatibility?.unchecked?.map((u) => u.path)).toEqual([expectedUnchecked]);
    expect(plugin?.compatibility?.unchecked?.[0]?.reason).toMatch(/EACCES|EPERM/);
    // The path in the reason is root-relative, like every other path in the document.
    expect(plugin?.compatibility?.unchecked?.[0]?.reason).not.toContain(tempDir);
    // The settings check ran too: the readable sibling's conflict is found...
    expect(bashConflictFiles(plugin)).toEqual([PLAIN_SKILL]);
    // ...and the refused path is named as unchecked, so `compatible` is not "fine by omission".
    expect(plugin?.settings?.compatible).toBe(false);
    expect(plugin?.settings?.unchecked?.map((u) => u.path)).toEqual([expectedUnchecked]);
    expect(plugin?.settings?.unchecked?.[0]?.reason).not.toContain(tempDir);
    // Said on stderr without --debug.
    expect(stderr).not.toContain('Compatibility analysis could not run');
    expect(stderr).toContain('1 settings conflict(s) found');
    expect(stderr).toContain('1 path(s) the settings check could not compare');
    // The compat lane's own unchecked path, on the same channel: a plugin the
    // analyzer could only partly read must not be silent on stderr while the
    // settings lane says its half.
    expect(stderr).toContain('1 path(s) the compatibility analysis could not read');
  });
});

describe('vat audit --compat --settings over a plugin whose skills are symlinks', () => {
  const cap = symlinkCapability();

  it.skipIf(cap === null)('checks a symlinked skill directory and a symlinked SKILL.md, agreeing with the validator lane', () => {
    if (cap === null) return;
    const shared = safePath.join(tempDir, 'shared');
    fs.mkdirSync(safePath.join(shared, LINKED_DIR), { recursive: true });
    fs.writeFileSync(safePath.join(shared, LINKED_DIR, 'SKILL.md'), bashSkill(LINKED_DIR));
    fs.writeFileSync(safePath.join(shared, 'linked-file.md'), bashSkill(LINKED_FILE));
    const pluginDir = writeSettingsPlugin(tempDir, 'sym-plugin', {});
    createSymlink(cap, safePath.join(shared, LINKED_DIR), safePath.join(pluginDir, 'skills', LINKED_DIR), 'dir');
    fs.mkdirSync(safePath.join(pluginDir, 'skills', LINKED_FILE), { recursive: true });
    createSymlink(cap, safePath.join(shared, 'linked-file.md'), safePath.join(pluginDir, 'skills', LINKED_FILE, 'SKILL.md'), 'file');

    const { exit, plugin, report } = auditWithSettings(pluginDir, settingsFile);

    expect(exit).toBe(0);
    // The control: the validator lane sees both skills in the same document.
    const validated = report.files.filter((f) => f.type === 'agent-skill').map((f) => f.path).sort((a, b) => a.localeCompare(b));
    expect(validated).toEqual([`skills/${LINKED_DIR}/SKILL.md`, `skills/${LINKED_FILE}/SKILL.md`]);
    // So the settings lane must reach them the same way.
    expect(bashConflictFiles(plugin).sort((a, b) => a.localeCompare(b))).toEqual(validated);
    expect(plugin?.settings?.compatible).toBe(false);
    expect(plugin?.settings?.unchecked).toBeUndefined();
  });
});
