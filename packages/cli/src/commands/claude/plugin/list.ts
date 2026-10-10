// packages/cli/src/commands/claude/plugin/list.ts
/**
 * `vat claude plugin list` — what Claude Code has installed locally, published
 * as the `Report<T>` envelope (`list-schema.ts`).
 *
 * Two registries are consulted every run: `installed_plugins.json` and the
 * legacy `skills/` directory. An absent one is empty; one the OS refuses ends
 * the run. A `--target` this verb does not list is the invocation's mistake.
 */

import { getClaudeUserPaths, listLocalPlugins, type ClaudeUserPaths, type PluginListResult } from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport } from '@vibe-agent-toolkit/schema';
import { Command } from 'commander';

import { CommandRefusalError, refusalCodeOf } from '../../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../../utils/document-writer.js';
import { createLogger } from '../../../utils/logger.js';

import type { PluginListReport } from './list-schema.js';

interface PluginListCommandOptions {
  target?: string;
  debug?: boolean;
}

/** `vat claude plugin list` has no `--strict`: it reports no finding to gate on. */
const GATE = { strict: false } as const;

/** Both registries, consulted on every run — absent is consulted-and-empty. */
const REGISTRIES_CONSULTED = 2;

export function createPluginListCommand(): Command {
  const command = new Command('list');

  command
    .description('List installed skill packages in Claude Code')
    .option('--target <target>', 'Target surface: code (default)', 'code')
    .option('--debug', 'Enable debug logging')
    .action(pluginListCommand)
    .addHelpText('after', `
Description:
  Lists all skill packages installed in Claude Code (default: local ~/.claude/).
  Consults both the plugin registry and the legacy skills directory; an absent
  one lists nothing.

Output (YAML report on stdout):
  - status: ok, or error when the run could not list
  - examined: registries consulted (2)
  - data.sources: the plugin registry file and legacy skills directory read
  - data.plugins[]: plugin-registry entries
  - data.legacySkills[]: legacy skills directory entries

Exit Codes:
  0 - Listed (nothing installed is still a listing)
  2 - The run could not list: an unsupported --target (USAGE_INVALID), or a registry that cannot be read

Example:
  $ vat claude plugin list          # List locally installed plugins
`);

  return command;
}

/**
 * Build the report. Pure: no file system, no `process.exit`.
 *
 * @param result - What the two registries hold
 * @param paths - Where they were read from
 * @param durationMs - How long the run took
 */
export function buildPluginListReport(result: PluginListResult, paths: ClaudeUserPaths, durationMs: number): PluginListReport {
  return buildReport({
    examined: REGISTRIES_CONSULTED,
    findings: [],
    data: {
      target: 'code',
      sources: { pluginRegistry: paths.installedPluginsPath, legacySkillsDir: paths.skillsDir },
      plugins: result.plugins,
      legacySkills: result.legacySkills,
    },
    gate: GATE,
    durationMs,
  });
}

function pluginListCommand(options: PluginListCommandOptions): void {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let report: PluginListReport;
  try {
    const target = options.target ?? 'code';
    if (target !== 'code') {
      throw new CommandRefusalError('USAGE_INVALID', `Unsupported --target "${target}": vat claude plugin list lists only --target code.`);
    }

    const paths = getClaudeUserPaths();
    logger.debug(`Consulting ${paths.installedPluginsPath} and ${paths.skillsDir}`);
    report = buildPluginListReport(listLocalPlugins(paths), paths, Date.now() - startTime);
  } catch (error) {
    endWithRefusal('claude plugin list', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }

  endWithReport('claude plugin list', report, 'yaml');
}
