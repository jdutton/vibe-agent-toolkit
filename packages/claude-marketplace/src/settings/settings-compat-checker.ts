/**
 * Check a plugin directory against effective settings for conflicts.
 */

import * as fs from 'node:fs/promises';
import { basename } from 'node:path';

import { allowedToolsOf, parseFrontmatter } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import type { SettingsConflict } from '../types.js';
import { reasonOf, walkFollowingLinks, type WalkedTree } from '../walk-following-links.js';

import { ruleConstrainsDeclaration } from './permission-matcher.js';
import type { EffectiveSettings, ProvenanceRule } from './settings-merger.js';

interface SkillFrontmatter {
  'allowed-tools'?: string[];
  model?: string;
}

/** A SKILL.md the checker read, and the fields it consults. */
interface ReadSkill {
  path: string;
  frontmatter: SkillFrontmatter;
}

/**
 * A path the settings check could not compare, and why.
 *
 * `path` is ABSOLUTE — the caller anchors it to its own document root. It is a
 * SKILL.md the checker could not read or parse, or a DIRECTORY it could not
 * list, in which case every skill beneath it is unseen and unnamed.
 */
export interface SettingsUnchecked {
  path: string;
  reason: string;
}

/**
 * What the settings check found, and what it never looked at.
 *
 * 🚩 The check used to answer with `conflicts` alone, and every path it failed
 * to see fell out of that answer as "no conflict" — an unlistable skill
 * directory, an unreadable SKILL.md, a frontmatter that would not parse, and a
 * skill reached through a symlink. Its consumer tried to recover the unchecked
 * list from the skill validator's result codes in the same run, which cannot
 * see a directory (no SKILL.md result exists for it) and never fired for an
 * unreadable file (the compat analyzer threw first). The checker is the one
 * that enumerated and read, so it is the one that says what it skipped.
 * `conflicts` being empty means "compatible" only when `unchecked` is too.
 */
export interface SettingsCheck {
  conflicts: SettingsConflict[];
  unchecked: SettingsUnchecked[];
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
 * Returns the refusal `reason` when the file cannot be read or its frontmatter
 * does not parse (a block that is not a YAML mapping — empty, `~`, a scalar —
 * is a parse failure at the seam, so no shape is guarded here). The skill
 * validator names the same file `SKILL_MISSING_FRONTMATTER` in the same
 * `vat audit`, off the same parser; the checker reports it as unchecked rather
 * than contributing nothing, because "nothing" reads as "no conflict".
 */
async function parseSkillFrontmatter(
  skillPath: string
): Promise<{ frontmatter: SkillFrontmatter } | { reason: string }> {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are from trusted plugin dir
    content = await fs.readFile(skillPath, 'utf-8');
  } catch (error) {
    return { reason: reasonOf(error) };
  }

  const parsed = parseFrontmatter(content);
  if (!parsed.success) return { reason: parsed.error };
  const fields = parsed.frontmatter;

  const frontmatter: SkillFrontmatter = {};
  const allowedTools = allowedToolsOf(fields['allowed-tools']);
  if (allowedTools !== undefined) {
    frontmatter['allowed-tools'] = allowedTools;
  }
  const model = fields['model'];
  if (typeof model === 'string' && model.trim() !== '') {
    frontmatter.model = model.trim();
  }
  return { frontmatter };
}

/**
 * Every SKILL.md within a plugin directory (recursive), and every directory the
 * walk could not list — the plugin root included, so a plugin that cannot be
 * listed at all is the one thing unchecked rather than a thrown check.
 *
 * The walk is SHARED with the compatibility analyzer (`walkFollowingLinks`):
 * it follows symlinks the way the audit's validator lane does and terminates
 * on a link back into an ancestor. Both lanes used to enumerate on their own,
 * and both lost a symlinked skill the same way — a `Dirent` for a link answers
 * `false` to `isFile()` and `isDirectory()` alike.
 */
async function findSkillFiles(pluginDir: string): Promise<{ skillFiles: string[]; unchecked: SettingsUnchecked[] }> {
  let tree: WalkedTree;
  try {
    tree = await walkFollowingLinks(pluginDir);
  } catch (error) {
    return { skillFiles: [], unchecked: [{ path: pluginDir, reason: reasonOf(error) }] };
  }
  return {
    skillFiles: tree.files.filter((file) => basename(file) === 'SKILL.md'),
    unchecked: tree.unlistable,
  };
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
function toolBlockingConflicts(
  skills: readonly ReadSkill[],
  denyRules: ProvenanceRule[],
  pluginDir: string
): SettingsConflict[] {
  const conflicts: SettingsConflict[] = [];

  for (const skill of skills) {
    for (const tool of skill.frontmatter['allowed-tools'] ?? []) {
      for (const { rule, provenance } of denyRules) {
        if (ruleConstrainsDeclaration(tool, rule, 'deny', pluginDir)) {
          conflicts.push({
            type: 'tool-blocked',
            detail: `Tool "${tool}" in ${safePath.relative(pluginDir, skill.path)} blocked by org policy (permissions.deny)`,
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

function modelUnavailabilityConflicts(
  skills: readonly ReadSkill[],
  effectiveSettings: EffectiveSettings,
  pluginDir: string
): SettingsConflict[] {
  if (!effectiveSettings.availableModels?.value) return [];

  const allowedModels = new Set(effectiveSettings.availableModels.value);
  const { provenance } = effectiveSettings.availableModels;
  const conflicts: SettingsConflict[] = [];

  for (const skill of skills) {
    const { model } = skill.frontmatter;
    if (model === undefined || allowedModels.has(model)) continue;

    conflicts.push({
      type: 'model-unavailable',
      detail: `Model "${model}" required by ${safePath.relative(pluginDir, skill.path)} is not in org's availableModels`,
      blockedBy: 'availableModels',
      value: effectiveSettings.availableModels.value.join(', '),
      settingsFile: provenance.file,
      settingsLevel: provenance.level,
    });
  }

  return conflicts;
}

/**
 * Check a plugin directory against effective settings for conflicts.
 *
 * Returns the conflicts found AND every path it could not compare — see
 * {@link SettingsCheck} for why the second half exists. A plugin is compatible
 * only when both lists are empty.
 *
 * Only deny rules are checked here — Claude Code evaluates deny → ask → allow
 * (first match wins), so a deny rule is the only bucket that can actually block
 * a tool the plugin needs. Ask rules prompt rather than block; allow rules permit.
 */
export async function checkSettingsCompatibility(
  pluginDir: string,
  effectiveSettings: EffectiveSettings
): Promise<SettingsCheck> {
  const { skillFiles, unchecked } = await findSkillFiles(pluginDir);

  // Each SKILL.md is read ONCE, here, and every lane below consults the same
  // reading — a file the checker could not read is unchecked for all of them.
  const skills: ReadSkill[] = [];
  for (const path of skillFiles) {
    const read = await parseSkillFrontmatter(path);
    if ('reason' in read) unchecked.push({ path, reason: read.reason });
    else skills.push({ path, frontmatter: read.frontmatter });
  }

  const conflicts = [
    ...toolBlockingConflicts(skills, effectiveSettings.permissions.deny, pluginDir),
    ...(await checkHookDisablingConflicts(pluginDir, effectiveSettings)),
    ...modelUnavailabilityConflicts(skills, effectiveSettings, pluginDir),
  ];

  return { conflicts, unchecked };
}
