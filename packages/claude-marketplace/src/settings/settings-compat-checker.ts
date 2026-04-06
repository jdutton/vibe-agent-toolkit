/**
 * Check a plugin directory against effective settings for conflicts.
 */

import * as fs from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { SettingsConflict } from '../types.js';

import { matchesPermissionRule } from './permission-matcher.js';
import type { EffectiveSettings, ProvenanceRule } from './settings-merger.js';

interface SkillFrontmatter {
  'allowed-tools'?: string[];
  model?: string;
}

function parseInlineTools(inline: string): string[] {
  if (inline.startsWith('[')) {
    return inline.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  return inline.split(',').map(s => s.trim()).filter(Boolean);
}

function parseAllowedTools(frontmatterText: string): string[] | undefined {
  const lines = frontmatterText.split('\n');
  const headerIdx = lines.findIndex(l => /^allowed-tools:/i.test(l));
  if (headerIdx === -1) return undefined;

  const header = lines[headerIdx] ?? '';
  // eslint-disable-next-line sonarjs/slow-regex -- input is a single pre-split line (bounded), no backtracking risk
  const headerMatch = /^allowed-tools:\s*([^\n]+)$/.exec(header);

  if (headerMatch?.[1]) {
    return parseInlineTools(headerMatch[1].trim());
  }

  // Multi-line list: following lines prefixed with "  - "
  const tools: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const itemMatch = /^ {2}- ([^\n]+)$/.exec(line);
    if (itemMatch?.[1]) {
      tools.push(itemMatch[1].trim());
    } else {
      break;
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Parse SKILL.md frontmatter fields we care about (allowed-tools, model).
 * Returns null if no frontmatter found.
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

  if (!content.startsWith('---')) return null;

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const frontmatterText = content.slice(3, endIdx).trim();
  const result: SkillFrontmatter = {};

  const allowedTools = parseAllowedTools(frontmatterText);
  if (allowedTools) {
    result['allowed-tools'] = allowedTools;
  }

  // Parse model
  const modelMatch = /^model:\s*(.+)/m.exec(frontmatterText);
  if (modelMatch?.[1]) {
    const raw = modelMatch[1].trim();
    result.model = /^['"](.+)['"]$/.exec(raw)?.[1] ?? raw;
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

function extractToolInput(tool: string): string {
  if (!tool.includes('(')) return '*';
  const idx = tool.indexOf('(');
  return tool.endsWith(')') ? tool.slice(idx + 1, -1) : tool.slice(idx + 1);
}

function isToolBlocked(
  toolName: string,
  toolInput: string,
  rule: string,
  pluginDir: string
): boolean {
  if (toolInput === '*') {
    return (
      matchesPermissionRule(toolName, '', rule, pluginDir) ||
      rule === toolName ||
      rule.startsWith(`${toolName}(`)
    );
  }
  return matchesPermissionRule(toolName, toolInput, rule, pluginDir);
}

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
      const toolName = tool.includes('(') ? tool.slice(0, tool.indexOf('(')) : tool;
      const toolInput = extractToolInput(tool);

      for (const { rule, provenance } of denyRules) {
        if (isToolBlocked(toolName, toolInput, rule, pluginDir)) {
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
