import { existsSync } from 'node:fs';

import {
	serializeInventory,
	serializeInventoryShallow,
	type AnyInventory,
} from '@vibe-agent-toolkit/agent-skills';
import {
	crawlSkillLinkRegistry,
	extractClaudeInstallInventory,
	extractClaudeMarketplaceInventory,
	extractClaudePluginInventory,
	extractClaudeSkillInventory,
	getClaudeUserPaths,
} from '@vibe-agent-toolkit/claude-marketplace';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { createLogger } from '../utils/logger.js';

import { gitTrackerForProjectRoot } from './audit/distributed-tree.js';

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

export async function routeInventory(
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
		// No shared registry: there is nothing to share it WITH. The extractor derives the
		// same root from the same skill path and crawls it exactly once, so handing it a
		// registry here would only duplicate that derivation — and get it wrong the moment
		// the two rules drift.
		//
		// A git-tracker source IS worth handing over even for one skill: the saving is per
		// LINK TARGET, not per skill. One `git ls-files` replaces one `git check-ignore`
		// spawn for every distinct target this skill's link graph reaches. It is also not
		// optional to hand over: the extractor requires a source, so a lane that wanted
		// none would have to say `NO_GIT_TRACKER` out loud.
		return extractClaudeSkillInventory(absolute, { gitTrackerSource: gitTrackerForProjectRoot });
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
		// No shared registry and no tracker source here: `extractClaudeMarketplaceInventory`
		// (like `extractClaudeInstallInventory` above) takes neither parameter, so every
		// plugin it fans out to re-crawls AND walks its links with the `git check-ignore`
		// oracle. Threading either through those two extractors is a claude-marketplace
		// change, not a CLI one — this call site cannot fix it from here.
		return extractClaudeMarketplaceInventory(absolute);
	}
	// Lazy, not eager: the extractor calls this only when it is about to walk its first
	// skill, so a plugin of commands/ and agents/ alone crawls nothing. The tracker source
	// is unconditional — it is asked per skill, about that skill's own root, and answers
	// `undefined` for any root it cannot serve.
	return extractClaudePluginInventory(
		absolute,
		linkRegistryProviderFor(absolute),
		gitTrackerForProjectRoot,
	);
}

/**
 * A way to obtain the ONE markdown registry every skill under `subjectDir` link-walks
 * against — or `undefined` when no single registry can serve them all.
 *
 * `extractClaudeSkillInventory` otherwise crawls and parses every document under the
 * project root once per skill, so an N-skill plugin paid N whole-corpus crawls (~11.9s
 * each on a ~1,041-document monorepo). Root discovery belongs at this CLI boundary —
 * inner functions take the root as a parameter — so the root is resolved eagerly here
 * and only the crawl is deferred.
 *
 * **Only a project root is shareable.** Reuse is gated on exact
 * `registry.baseDir === projectRoot` equality against the root the extractor derives per
 * skill (`findProjectRoot(dirname(skillMd)) ?? dirname(skillMd)`). When `findProjectRoot`
 * finds nothing, that per-skill fallback is each skill's OWN directory — three skills
 * mean three different roots, and a registry rooted at the plugin answers a different
 * question for all three. It would be crawled, compared, discarded, and re-crawled per
 * skill: measured at 1308ms against 863ms for building nothing at all, i.e. 1.5x SLOWER
 * than the N+1 it was meant to remove. So: no root, no provider.
 *
 * Returning a provider rather than a registry keeps the CLI out of the business of
 * guessing whether the subject has any skills — a guess that would duplicate the
 * extractor's discovery rule and drift from it. `extractClaudePluginInventory` memoizes
 * the call, so whenever a provider IS returned the crawl happens at most once however
 * many skills it finds. Mirrors `vat audit`'s `getOrCreateInventoryRegistry`.
 */
function linkRegistryProviderFor(
	subjectDir: string,
): (() => Promise<Awaited<ReturnType<typeof crawlSkillLinkRegistry>>>) | undefined {
	const projectRoot = findProjectRoot(subjectDir);
	if (projectRoot === null) return undefined;
	return () => crawlSkillLinkRegistry(projectRoot);
}
