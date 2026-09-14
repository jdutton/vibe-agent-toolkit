/**
 * `vat audit --compat --settings`: a skill whose frontmatter could not be READ
 * must not be reported as compatible with the settings.
 *
 * The settings checker reads each SKILL.md's `allowed-tools` and `model` to
 * compare against the org's deny rules and available models. A SKILL.md whose
 * frontmatter does not parse contributes NOTHING to that comparison — the
 * checker cannot read it, and the audit's own validator reports the same
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

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditWithSettings,
  bashSkill,
  type Report,
  writeDenyBashSettings,
  writeSettingsPlugin,
} from './audit-settings-fixture.js';

const UNCHECKED_SKILL = 'skills/unchecked/SKILL.md';

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

beforeAll(() => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-settings-unchecked-'));
  mixedPluginDir = writeSettingsPlugin(tempDir, 'mixed-plugin', { checked: bashSkill('checked'), unchecked: UNCHECKED_FRONTMATTER });
  lonelyPluginDir = writeSettingsPlugin(tempDir, 'lonely-plugin', { unchecked: UNCHECKED_FRONTMATTER });
  settingsFile = writeDenyBashSettings(tempDir);
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function auditPlugin(pluginDir: string): ReturnType<typeof auditWithSettings> {
  return auditWithSettings(pluginDir, settingsFile, ['--verbose']);
}

function issueCodes(report: Report): string[] {
  return report.files.flatMap((f) => f.issues ?? []).map((i) => i.code);
}

describe('vat audit --compat --settings with a skill whose frontmatter cannot be parsed', () => {
  it('still finds the real conflict on the skill it COULD read', () => {
    const { exit, plugin } = auditPlugin(mixedPluginDir);

    // Exit 1, not 0: malformed frontmatter is the SKILL's defect
    // (`SKILL_MISSING_FRONTMATTER`, error severity), and the audit exits 1 on
    // any error-severity finding. Only a path the OS REFUSED is "degraded" at
    // exit 0 — that case is `audit-settings-unreachable-skill`.
    expect(exit).toBe(ExitCode.FINDINGS);
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
    const { exit, plugin, report } = auditPlugin(lonelyPluginDir);

    // The unparseable skill is an error-severity finding on its own, so the run gates.
    expect(exit).toBe(ExitCode.FINDINGS);
    expect(issueCodes(report)).toContain('SKILL_MISSING_FRONTMATTER');
    expect(plugin?.settings?.conflicts).toEqual([]);
    expect(plugin?.settings?.compatible).toBe(false);
    expect(plugin?.settings?.unchecked?.map((u) => u.path)).toEqual([UNCHECKED_SKILL]);
  });
});
