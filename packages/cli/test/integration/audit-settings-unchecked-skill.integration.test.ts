/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * `vat audit --compat --settings`: a skill whose frontmatter could not be READ
 * must not be reported as compatible with the settings.
 *
 * The settings checker reads each SKILL.md's `allowed-tools` and `model` to
 * compare against the org's deny rules and available models. A SKILL.md whose
 * frontmatter does not parse contributes NOTHING to that comparison — the
 * checker skips it, by design, and the audit's own validator reports the same
 * file as `SKILL_MISSING_FRONTMATTER`. But the renderer derived
 * `settings.compatible` from "no conflicts found", so a plugin whose only
 * declared-tools skill was unparseable printed `compatible: true` beside an
 * error saying that skill could not be read. "Not checked" was rendered as
 * "checked and fine".
 *
 * Two skills, so the two answers are distinguishable in one report: `checked`
 * declares a tool the fixture settings deny (a real conflict, which must still
 * be found), and `unchecked` has malformed frontmatter (which must be reported
 * as unchecked, not as compatible).
 */

import fs from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { runAuditCli } from '../test-helpers.js';

interface SettingsBlock {
  compatible: boolean;
  conflicts: Array<{ type: string; detail: string }>;
  unchecked?: Array<{ path: string; reason: string }>;
}
interface ReportFile { path: string; type: string; settings?: SettingsBlock }
interface Report { files: ReportFile[] }

const UNCHECKED_SKILL = 'skills/unchecked/SKILL.md';

/** Frontmatter the settings checker CAN read: a tool the fixture settings deny. */
const CHECKED_FRONTMATTER = '---\nname: checked\ndescription: A skill that declares a tool the settings deny.\nallowed-tools: Bash\n---\n';
/**
 * Malformed YAML — an unclosed flow sequence. The validator reports the file as
 * SKILL_MISSING_FRONTMATTER; the settings checker cannot read its tools, and the
 * `allowed-tools: Bash` it carries is exactly the conflict that goes unseen.
 */
const UNCHECKED_FRONTMATTER = '---\nname: unchecked\ndescription: [unclosed\nallowed-tools: Bash\n---\n';

let tempDir: string;
/** Two skills: one the check reads (and finds a conflict in), one it cannot. */
let mixedPluginDir: string;
/** One skill, unparseable: the plugin the old renderer called `compatible: true`. */
let lonelyPluginDir: string;
let settingsFile: string;

function writePlugin(name: string, skills: Record<string, string>): string {
  const pluginDir = safePath.join(tempDir, name);
  fs.mkdirSync(safePath.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: 'A plugin with an unparseable skill.', version: '0.0.1' }),
  );
  for (const [skill, frontmatter] of Object.entries(skills)) {
    const dir = safePath.join(pluginDir, 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(safePath.join(dir, 'SKILL.md'), `${frontmatter}\n# ${skill}\n\nBody.\n`);
  }
  return pluginDir;
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-settings-unchecked-'));
  mixedPluginDir = writePlugin('mixed-plugin', { checked: CHECKED_FRONTMATTER, unchecked: UNCHECKED_FRONTMATTER });
  lonelyPluginDir = writePlugin('lonely-plugin', { unchecked: UNCHECKED_FRONTMATTER });
  settingsFile = safePath.join(tempDir, 'managed-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: ['Bash'] } }));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function auditPlugin(pluginDir: string): { exit: number | null; plugin: ReportFile | undefined; report: Report } {
  const result = runAuditCli(pluginDir, ['--compat', '--settings', settingsFile, '--verbose']);
  const report = parseYaml(result.stdout) as Report;
  return { exit: result.status, report, plugin: report.files.find((f) => f.type === 'claude-plugin') };
}

function issueCodes(report: Report): string[] {
  return report.files.flatMap((f) => (f as { issues?: Array<{ code: string }> }).issues ?? []).map((i) => i.code);
}

describe('vat audit --compat --settings with a skill whose frontmatter cannot be parsed', () => {
  it('still finds the real conflict on the skill it COULD read', () => {
    const { exit, plugin } = auditPlugin(mixedPluginDir);

    expect(exit).toBe(0);
    expect(plugin?.settings?.conflicts.map((c) => c.type)).toContain('tool-blocked');
  });

  it('lists the unchecked skill beside the conflicts it did find', () => {
    const { plugin, report } = auditPlugin(mixedPluginDir);

    // The control that makes the assertion meaningful: the audit itself says
    // this skill could not be read, in the same document.
    expect(issueCodes(report)).toContain('SKILL_MISSING_FRONTMATTER');
    expect(plugin?.settings?.compatible).toBe(false);
    expect(plugin?.settings?.unchecked?.map((u) => u.path)).toEqual([UNCHECKED_SKILL]);
    expect(plugin?.settings?.unchecked?.[0]?.reason).toBeTruthy();
  });

  // THE defect: zero conflicts found, because the only skill that declares a
  // denied tool could not be read — and "zero conflicts" rendered as compatible.
  it('does not report a plugin compatible when its only skill went unchecked', () => {
    const { plugin, report } = auditPlugin(lonelyPluginDir);

    expect(issueCodes(report)).toContain('SKILL_MISSING_FRONTMATTER');
    expect(plugin?.settings?.conflicts).toEqual([]);
    expect(plugin?.settings?.compatible).toBe(false);
    expect(plugin?.settings?.unchecked?.map((u) => u.path)).toEqual([UNCHECKED_SKILL]);
  });
});
