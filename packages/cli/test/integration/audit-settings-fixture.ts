/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/**
 * Shared fixture for the `vat audit --compat --settings` integration suites: a
 * plugin whose skills declare a tool the fixture settings deny, and the parsed
 * shape of the two blocks the command renders for it.
 */

import fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { parse as parseYaml } from 'yaml';

import { runAuditCli } from '../test-helpers.js';

export interface SettingsBlock {
  compatible: boolean;
  conflicts: Array<{ type: string; detail: string }>;
  unchecked?: Array<{ path: string; reason: string }>;
}
export interface CompatibilityBlock {
  analyzed?: false;
  reason?: string;
  observations?: Array<{ code: string }>;
  unchecked?: Array<{ path: string; reason: string }>;
}
export interface ReportFile {
  path: string;
  type: string;
  issues?: Array<{ code: string }>;
  compatibility?: CompatibilityBlock;
  settings?: SettingsBlock;
}
export interface Report { files: ReportFile[] }

/** Frontmatter declaring `Bash`, the tool every fixture settings file denies. */
export function bashSkill(name: string): string {
  return `---\nname: ${name}\ndescription: A skill that declares a tool the settings deny.\nallowed-tools: Bash\n---\n# ${name}\n`;
}

/** A plugin under `tempDir` with `skills/<name>/SKILL.md` for each entry (and an empty `skills/` otherwise). */
export function writeSettingsPlugin(tempDir: string, name: string, skills: Record<string, string>): string {
  const pluginDir = safePath.join(tempDir, name);
  fs.mkdirSync(safePath.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(safePath.join(pluginDir, 'skills'), { recursive: true });
  fs.writeFileSync(
    safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: 'A plugin with a skill the settings check must account for.', version: '0.0.1' }),
  );
  for (const [skill, content] of Object.entries(skills)) {
    const dir = safePath.join(pluginDir, 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(safePath.join(dir, 'SKILL.md'), content);
  }
  return pluginDir;
}

/** A settings file denying `Bash`, beside the fixtures. */
export function writeDenyBashSettings(tempDir: string): string {
  const settingsFile = safePath.join(tempDir, 'managed-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: ['Bash'] } }));
  return settingsFile;
}

/** `vat audit --compat --settings <file>` over `pluginDir`, parsed, with the plugin's own entry picked out. */
export function auditWithSettings(
  pluginDir: string,
  settingsFile: string,
  extraArgs: string[] = [],
): { exit: number | null; stderr: string; plugin: ReportFile | undefined; report: Report } {
  const result = runAuditCli(pluginDir, ['--compat', '--settings', settingsFile, ...extraArgs]);
  const report = parseYaml(result.stdout) as Report;
  return { exit: result.status, stderr: result.stderr, report, plugin: report.files.find((f) => f.type === 'claude-plugin') };
}

/** The skill files the settings block reports a Bash conflict on. */
export function bashConflictFiles(plugin: ReportFile | undefined): string[] {
  return (plugin?.settings?.conflicts ?? []).map((c) => /^Tool "Bash" in (.*) blocked/.exec(c.detail)?.[1] ?? c.detail);
}
