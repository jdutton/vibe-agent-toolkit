import { existsSync } from 'node:fs';

import {
	serializeInventory,
	serializeInventoryShallow,
	type AnyInventory,
} from '@vibe-agent-toolkit/agent-skills';
import {
	extractClaudeInstallInventory,
	extractClaudeMarketplaceInventory,
	extractClaudePluginInventory,
	extractClaudeSkillInventory,
	getClaudeUserPaths,
} from '@vibe-agent-toolkit/claude-marketplace';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { createLogger } from '../utils/logger.js';

export interface InventoryCommandOptions {
	user?: boolean;
	system?: boolean;
	format?: 'yaml' | 'json';
	shallow?: boolean;
	debug?: boolean;
}

/**
 * Create and configure the `vat inventory` command.
 */
export function createInventoryCommand(): Command {
	const command = new Command('inventory');
	command
		.description('Extract structural inventory of a plugin, marketplace, skill, or install root')
		.argument('[path]', 'Path to inventory (directory or SKILL.md)')
		.option('--user', 'Inventory the user-level Claude install (~/.claude/plugins)')
		.option('--system', 'Inventory the system-level Claude install')
		.option('--format <yaml|json>', 'Output format', 'yaml')
		.option('--shallow', 'Omit nested inventories (paths only)')
		.option('--debug', 'Verbose logging to stderr')
		.action(inventoryCommand)
		.addHelpText('after', `
Description:
  Extract and emit the structural inventory of a Claude plugin, marketplace,
  skill, or install root. Outputs YAML to stdout by default. Runs no validation
  detectors — pure structural enumeration.

Output:
  - schema: vat.inventory/v1alpha
  - kind: marketplace | plugin | skill | install
  - vendor: claude-code
  - declared / discovered / references / unexpected (per kind)
  - parseErrors: any manifest parse failures

Exit Codes:
  0 - Inventory extracted (parse errors surface in output, not as exit code)
  2 - System error (path not found, --system not supported, etc.)

Example:
  $ vat inventory my-plugin/                # Inventory a single plugin
`);
	return command;
}

/**
 * Action handler for `vat inventory [path]`.
 */
export async function inventoryCommand(
	pathArg: string | undefined,
	options: InventoryCommandOptions,
): Promise<void> {
	const logger = createLogger(options.debug === true ? { debug: true } : {});
	const startTime = Date.now();
	try {
		const inv = await routeInventory(pathArg, options);
		const format = options.format ?? 'yaml';
		const out = options.shallow === true
			? serializeInventoryShallow(inv, format)
			: serializeInventory(inv, format);
		process.stdout.write(out);
		process.exit(0);
	} catch (error) {
		handleCommandError(error, logger, startTime, 'Inventory');
	}
}

async function routeInventory(
	pathArg: string | undefined,
	options: InventoryCommandOptions,
): Promise<AnyInventory> {
	if (options.user === true) {
		return extractClaudeInstallInventory(getClaudeUserPaths());
	}
	if (options.system === true) {
		throw new Error('--system inventory is not implemented in this version');
	}
	if (!pathArg) {
		throw new Error('Path argument is required (or use --user / --system).');
	}
	const absolute = safePath.resolve(pathArg);
	if (absolute.endsWith('SKILL.md') || absolute.endsWith('skill.md')) {
		return extractClaudeSkillInventory(absolute);
	}
	const claudePluginDir = safePath.join(absolute, '.claude-plugin');
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute is caller-resolved, used for presence check only
	const hasMarketplace = existsSync(safePath.join(claudePluginDir, 'marketplace.json'));
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute is caller-resolved, used for presence check only
	const hasPlugin = existsSync(safePath.join(claudePluginDir, 'plugin.json'));
	// A directory with marketplace.json but no plugin.json is a marketplace root.
	// When both are present, the plugin extractor takes precedence (plugin is installed,
	// marketplace.json is a cached metadata artifact alongside it).
	if (hasMarketplace && !hasPlugin) {
		return extractClaudeMarketplaceInventory(absolute);
	}
	return extractClaudePluginInventory(absolute);
}
