// packages/cli/src/commands/claude/plugin/uninstall.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findPluginsByPackage, getClaudeUserPaths, uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';

import { writeYamlHeader } from './helpers.js';

interface PluginUninstallCommandOptions {
  all?: boolean;
  dryRun?: boolean;
  debug?: boolean;
}

export function createPluginUninstallCommand(): Command {
  const command = new Command('uninstall');

  command
    .description('Remove a skill package from Claude Code')
    .argument('[plugin@marketplace]', 'Plugin key to uninstall (e.g. my-skill@my-marketplace)')
    .option('-a, --all', 'Uninstall all plugins from the npm package in the current directory', false)
    .option('--dry-run', 'Preview removal without making changes', false)
    .option('--debug', 'Enable debug logging')
    .action(pluginUninstallCommand)
    .addHelpText('after', `
Description:
  Removes a skill package from Claude Code, reversing all install artifacts.
  With --all, finds all plugins installed from the npm package in the current directory.

  Idempotent: exits 0 if the plugin is not installed.

Output:
  - status: success
  - pluginsRemoved: number of plugins uninstalled
  - plugins[]: per-plugin result with removed flag and artifact details

Exit Codes:
  0 - Uninstall successful (or plugin was not installed)
  1 - Uninstall error
  2 - System error

Example:
  $ vat claude plugin uninstall my-skill@my-marketplace
  $ vat claude plugin uninstall --all           # uninstall all from cwd package
  $ vat claude plugin uninstall --all --dry-run # preview
`);

  return command;
}

async function pluginUninstallCommand(
  pluginKeyArg: string | undefined,
  options: PluginUninstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const paths = getClaudeUserPaths();
    const pluginKeys = resolvePluginKeys(pluginKeyArg, options, logger);

    if (pluginKeys.length === 0) {
      if (options.all) {
        // No plugins installed from this package — valid no-op
        writeYamlHeader(options.dryRun);
        process.stdout.write(`pluginsRemoved: 0\n`);
        process.stdout.write(`plugins: []\n`);
        process.stdout.write(`duration: ${Date.now() - startTime}ms\n`);
        process.exit(0);
      }
      logger.error('No plugins found to uninstall');
      process.exit(1);
    }

    const results: Array<{ key: string; removed: boolean; warning?: string }> = [];

    for (const pluginKey of pluginKeys) {
      // exactOptionalPropertyTypes: only pass dryRun when defined to avoid explicit undefined
      const uninstallOpts = options.dryRun === undefined
        ? { pluginKey, paths }
        : { pluginKey, paths, dryRun: options.dryRun };
      const result = await uninstallPlugin(uninstallOpts);
      const entry: { key: string; removed: boolean; warning?: string } = {
        key: pluginKey,
        removed: result.removed,
      };
      if (result.warning !== undefined) {
        entry.warning = result.warning;
        logger.info(`   ⚠️  ${result.warning}`);
      }
      results.push(entry);
    }

    const removed = results.filter(r => r.removed);

    writeYamlHeader(options.dryRun);
    process.stdout.write(`pluginsRemoved: ${removed.length}\n`);
    process.stdout.write(`plugins:\n`);
    for (const r of results) {
      process.stdout.write(`  - key: ${r.key}\n`);
      process.stdout.write(`    removed: ${r.removed}\n`);
      if (r.warning) process.stdout.write(`    warning: "${r.warning}"\n`);
    }
    process.stdout.write(`duration: ${Date.now() - startTime}ms\n`);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'PluginUninstall');
  }
}

function resolvePluginKeys(
  pluginKeyArg: string | undefined,
  options: PluginUninstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): string[] {
  if (options.all) {
    const cwd = process.cwd();
    const pkgRaw = readFileSync(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { name: string };
    logger.info(`📦 Finding all plugins from ${pkg.name}...`);
    return findPluginsByPackage(pkg.name, getClaudeUserPaths());
  }

  if (!pluginKeyArg) {
    throw new Error(
      'Plugin key required. Usage:\n' +
      '  vat claude plugin uninstall <plugin@marketplace>\n' +
      '  vat claude plugin uninstall --all'
    );
  }
  return [pluginKeyArg];
}
