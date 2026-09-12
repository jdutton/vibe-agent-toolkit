/**
 * Check a plugin directory against effective settings for conflicts.
 */

import * as fs from 'node:fs/promises';

import { allowedToolsOf, parseFrontmatter } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import type { SettingsConflict } from '../types.js';

import { ruleConstrainsDeclaration } from './permission-matcher.js';
import type { EffectiveSettings, ProvenanceRule } from './settings-merger.js';

interface SkillFrontmatter {
  'allowed-tools'?: string[];
  model?: string;
}

/**
 * Read the SKILL.md frontmatter fields this checker consults (`allowed-tools`,
 * `model`), through the SAME parser the skill validator uses.
 *
 * 🚩 This used to be a hand parser: an inline value split on `,` only, and a
 * block list that accepted exactly two-space `  - ` items. So the documented
 * space-separated spelling `allowed-tools: Read Edit` became ONE declaration
 * named `Read Edit`, which matches no rule, and a four-space YAML list became
 * `undefined`, which skipped the skill — both reported "no conflict" against an
 * org deny that the comma and two-space spellings reported. Under-reporting is
 * the direction this module's own contract calls unsafe, and it was decided by
 * how the author indented.
 *
 * Returns `null` when the file cannot be read or its frontmatter does not
 * parse. ⚠️ That is not a silent skip: `SettingsConflict[]` has no slot for
 * "this skill is unreadable", and it does not need one — the skill validator
 * runs on the same file in the same `vat audit` and names the failure as
 * `SKILL_MISSING_FRONTMATTER` (severity error) carrying the YAML parser's
 * message. Sharing `parseFrontmatter` is what keeps the two in agreement: the
 * checker contributes nothing for exactly the files the validator calls
 * unreadable, never for a file it merely failed to hand-parse.
 */
async function parseSkillFrontmatter(
  skillPath: string
): Promise<SkillFrontmatter | null> {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are from trusted plugin dir
    content = await fs.readFile(skillPath, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseFrontmatter(content);
  if (!parsed.success) return null;
  // `yaml.parse` of an empty document is `null`, and a scalar document is not a mapping.
  const frontmatter: unknown = parsed.frontmatter;
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return null;
  const fields = frontmatter as Record<string, unknown>;

  const result: SkillFrontmatter = {};
  const allowedTools = allowedToolsOf(fields['allowed-tools']);
  if (allowedTools !== undefined) {
    result['allowed-tools'] = allowedTools;
  }
  const model = fields['model'];
  if (typeof model === 'string' && model.trim() !== '') {
    result.model = model.trim();
  }
  return result;
}

/**
 * Find all SKILL.md files within a plugin directory (recursive).
 */
async function findSkillFiles(pluginDir: string): Promise<string[]> {
  const skillFiles: string[] = [];

  async function scanDir(dir: string): Promise<void> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted plugin dir
      const entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });

      for (const entry of entries) {
        if (entry.name === 'SKILL.md' && entry.isFile()) {
          skillFiles.push(safePath.join(dir, entry.name));
        } else if (entry.isDirectory()) {
          await scanDir(safePath.join(dir, entry.name));
        }
      }
    } catch {
      // Directory not readable — skip silently
    }
  }

  await scanDir(pluginDir);
  return skillFiles;
}

/**
 * Check if a plugin has a hooks.json file.
 */
async function hasHooksFile(pluginDir: string): Promise<boolean> {
  const hooksPath = safePath.join(pluginDir, 'hooks.json');
  try {
    await fs.access(hooksPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every `allowed-tools:` entry an org DENY rule constrains.
 *
 * 🔑 The lane is not incidental. Every rule reaching here comes from
 * `effectiveSettings.permissions.deny`, and Claude Code's deny matching is not
 * the mirror of its allow matching — a deny rule applies when ANY subcommand
 * matches, reaches into nested commands, and matches past a leading assignment.
 * Asking the allow-lane question here under-matches, and an under-match in this
 * checker is silently reported to the adopter as "no conflict" for a tool their
 * org policy actually blocks. `lane` is a REQUIRED argument throughout the
 * matcher and has no default, so this can never drift back by omission.
 *
 * ⛔ This module asks ONE question of the matcher and interprets nothing itself.
 * That is a rule with two scars behind it, both of the same shape — the checker
 * deciding on its own what a SKILL.md spelling means:
 *
 * - It answered *"does this rule constrain the tool at all?"* with
 *   `rule.startsWith(`${toolName}(`)`, which knows nothing of the matcher's
 *   ruling that a `Write`/`Glob`/`NotebookRead`/`NotebookEdit` PATH rule blocks
 *   nothing. `Write(./secrets/**)` was reported as blocking a skill spelling the
 *   tool `Write` and not one spelling it `Write(./out/**)`. That branch also
 *   CRASHED on the consulted half, handing the path lane an empty path, which
 *   node-ignore refuses with `path must not be empty` — `vat audit` died on any
 *   plugin declaring a bare `Read`/`Edit` against an org path rule.
 * - It then pulled the parenthesised text out of the entry and passed it as a
 *   CONCRETE tool input. Every partial wildcard — `Bash(git:*)`, `Read(./**)`,
 *   the spellings Claude Code's own documentation uses — was tested as a command
 *   literally named `git:*` or a file literally named `./**`, so bare `Bash`
 *   reported a conflict with `Bash(git push:*)` and `Bash(git:*)` did not.
 *
 * `ruleConstrainsDeclaration` takes the entry WHOLE and answers off the same
 * taxonomy that decides a concrete input, so there is exactly one answer per
 * (declaration, rule) pair and this file has no spelling logic left to drift.
 */
async function checkToolBlockingConflicts(
  skillFiles: string[],
  denyRules: ProvenanceRule[],
  pluginDir: string
): Promise<SettingsConflict[]> {
  const conflicts: SettingsConflict[] = [];

  for (const skillFile of skillFiles) {
    const frontmatter = await parseSkillFrontmatter(skillFile);
    if (!frontmatter?.['allowed-tools']) continue;

    for (const tool of frontmatter['allowed-tools']) {
      for (const { rule, provenance } of denyRules) {
        if (ruleConstrainsDeclaration(tool, rule, 'deny', pluginDir)) {
          conflicts.push({
            type: 'tool-blocked',
            detail: `Tool "${tool}" in ${safePath.relative(pluginDir, skillFile)} blocked by org policy (permissions.deny)`,
            blockedBy: 'permissions.deny',
            value: rule,
            settingsFile: provenance.file,
            settingsLevel: provenance.level,
          });
          break; // Only report first matching deny rule per tool
        }
      }
    }
  }

  return conflicts;
}

async function checkHookDisablingConflicts(
  pluginDir: string,
  effectiveSettings: EffectiveSettings
): Promise<SettingsConflict[]> {
  if (effectiveSettings.disableAllHooks?.value !== true) return [];

  const hasHooks = await hasHooksFile(pluginDir);
  if (!hasHooks) return [];

  const { provenance } = effectiveSettings.disableAllHooks;
  return [
    {
      type: 'hook-disabled',
      detail: 'Plugin declares hooks but hooks are disabled by org policy (disableAllHooks: true)',
      blockedBy: 'disableAllHooks',
      value: 'true',
      settingsFile: provenance.file,
      settingsLevel: provenance.level,
    },
  ];
}

async function checkModelUnavailabilityConflicts(
  skillFiles: string[],
  effectiveSettings: EffectiveSettings,
  pluginDir: string
): Promise<SettingsConflict[]> {
  if (!effectiveSettings.availableModels?.value) return [];

  const allowedModels = new Set(effectiveSettings.availableModels.value);
  const { provenance } = effectiveSettings.availableModels;
  const conflicts: SettingsConflict[] = [];

  for (const skillFile of skillFiles) {
    const frontmatter = await parseSkillFrontmatter(skillFile);
    if (!frontmatter?.model) continue;

    if (!allowedModels.has(frontmatter.model)) {
      conflicts.push({
        type: 'model-unavailable',
        detail: `Model "${frontmatter.model}" required by ${safePath.relative(pluginDir, skillFile)} is not in org's availableModels`,
        blockedBy: 'availableModels',
        value: effectiveSettings.availableModels.value.join(', '),
        settingsFile: provenance.file,
        settingsLevel: provenance.level,
      });
    }
  }

  return conflicts;
}

/**
 * Check a plugin directory against effective settings for conflicts.
 * Returns conflicts found; empty array means no issues.
 *
 * Only deny rules are checked here — Claude Code evaluates deny → ask → allow
 * (first match wins), so a deny rule is the only bucket that can actually block
 * a tool the plugin needs. Ask rules prompt rather than block; allow rules permit.
 */
export async function checkSettingsCompatibility(
  pluginDir: string,
  effectiveSettings: EffectiveSettings
): Promise<SettingsConflict[]> {
  const skillFiles = await findSkillFiles(pluginDir);

  const [toolConflicts, hookConflicts, modelConflicts] = await Promise.all([
    checkToolBlockingConflicts(skillFiles, effectiveSettings.permissions.deny, pluginDir),
    checkHookDisablingConflicts(pluginDir, effectiveSettings),
    checkModelUnavailabilityConflicts(skillFiles, effectiveSettings, pluginDir),
  ]);

  return [...toolConflicts, ...hookConflicts, ...modelConflicts];
}
