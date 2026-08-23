import { existsSync } from 'node:fs';

import {
	serializeInventory,
	serializeInventoryShallow,
	type AnyInventory,
} from '@vibe-agent-toolkit/agent-skills';
import {
	buildInventoryPopulation,
	crawlSkillLinkRegistry,
	extractClaudeInstallInventory,
	extractClaudeMarketplaceInventory,
	extractClaudePluginInventory,
	extractClaudeSkillInventory,
	getClaudeUserPaths,
	projectionCrawlSelected,
	type SharedPopulationSource,
} from '@vibe-agent-toolkit/claude-marketplace';
import { type PopulationCache } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { populationWiring } from '../utils/population-wiring.js';
import { withPopulationCache } from '../utils/projection-store.js';

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
		const inv = await routeInventory(pathArg, options, logger);
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

/**
 * Dispatch to the extractor the subject's shape calls for.
 *
 * @param pathArg - The path argument, or undefined under `--user` / `--system`
 * @param options - The command's flags
 * @param logger - Where diagnostics go. Defaults to a REPORTING logger, never a
 *   silent one: the default has to be the loud behaviour, or a caller acquires
 *   silence by leaving an argument off — which is the exact defect the blob
 *   stage's refusal counts were lost to in the first place
 * @returns The extracted inventory
 */
export async function routeInventory(
	pathArg: string | undefined,
	options: InventoryCommandOptions,
	logger: Logger = createLogger(),
): Promise<AnyInventory> {
	if (options.user === true) {
		// The tracker source is REQUIRED here now, and this is the lane it matters
		// most on: `--user` walks every cached plugin under ~/.claude/plugins/cache,
		// and until 2026-08-15 every one of those skills answered its gitignore
		// questions with a `git check-ignore` spawn per link target because the
		// obligation stopped at `extract-plugin.ts`.
		return extractClaudeInstallInventory({
			pathsOrRoot: getClaudeUserPaths(),
			gitTrackerSource: gitTrackerForProjectRoot,
		});
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
		// A tracker source but deliberately NO shared registry: that extractor accepts
		// only the former, because a marketplace fans out to plugins that each sit in
		// their own directory, so one registry matches none of their skills' project
		// roots and was measured 1.5x SLOWER than the N+1 crawl. The tracker source is
		// the opposite case — asked per skill about its own root, `undefined` where it
		// cannot serve — so it costs nothing where it does not apply.
		//
		// ⚠️ NO shared POPULATION either, and that is the same decision rather than an
		// oversight: a population is rooted, and `membersOf` refuses any root that is not
		// the one the extractor derives per skill. Rooted at the marketplace it would
		// match no skill and answer nothing; rooted per plugin it is not shared. So this
		// subject shape keeps the walk, and **the flip is plugin-directory-only** — as are
		// the `--user` and single-`SKILL.md` lanes above, for the same rootedness reason.
		// Measured 2026-08-15 on three real marketplace roots (35/51/29 skills): both arms
		// filed only the walker's `crawl` stratum, no `base`/`closure`, so their identical
		// output is the two arms agreeing about ONE lane, not evidence about the flip.
		return extractClaudeMarketplaceInventory(absolute, {
			gitTrackerSource: gitTrackerForProjectRoot,
		});
	}
	// Lazy, not eager: the extractor calls this only when it is about to walk its first
	// skill, so a plugin of commands/ and agents/ alone crawls nothing. The tracker source
	// is unconditional — it is asked per skill, about that skill's own root, and answers
	// `undefined` for any root it cannot serve.
	const sharedRegistry = linkRegistryProviderFor(absolute);
	// Root discovery at the CLI boundary, once, and then handed down — both the
	// population provider and the store key are rooted, and deriving the root
	// twice is how two rules drift into disagreeing about which corpus this is.
	const projectRoot = findProjectRoot(absolute);
	// The store scopes the whole extraction, not the provider call: the extractor
	// MEMOIZES `sharedPopulation` and reaches it when it is about to walk its
	// first skill, which is after this frame would otherwise have closed it.
	return withPopulationCache({ root: projectRoot ?? absolute }, async (cache) => {
		const sharedPopulation = populationProviderFor(projectRoot, cache, logger);
		return extractClaudePluginInventory(absolute, {
			...(sharedRegistry !== undefined && { sharedRegistry }),
			...(sharedPopulation !== undefined && { sharedPopulation }),
			gitTrackerSource: gitTrackerForProjectRoot,
		});
	});
}

/**
 * The projection-backed membership lane — **now the default for this command** —
 * or `undefined` to fall back to the incumbent link walk.
 *
 * Gated on two things, in this order:
 *
 * 1. **Not `VAT_INVENTORY_CRAWL=walker`.** The projection answers this command's
 *    membership question unless a caller asks for the walk back. It shipped the
 *    other way round, gated off, while it was a second implementation being
 *    measured against the first; it is now the implementation, with the walk kept
 *    reachable as an escape hatch and as the lab's B arm. ⚠️ It is ~5.3× slower on
 *    a real adopter and that was a deliberate, accepted trade — see
 *    {@link projectionCrawlSelected} for the measurement and for why neither half
 *    of the cost can be trimmed without changing the answer.
 * 2. **A discoverable project root**, exactly as {@link linkRegistryProviderFor}
 *    requires and for the identical reason: membership is resolved relative to a
 *    root, and where `findProjectRoot` finds none the extractor falls back to each
 *    skill's OWN directory — so one population rooted at the plugin would answer a
 *    different question for every skill. No root, no provider.
 *
 * Root discovery belongs at this CLI boundary; this function takes the root the
 * caller already discovered rather than discovering a second one.
 *
 * The tracker is resolved here too, and its absence is not cosmetic: with no
 * tracker `resource_realizations.gitignored` is `false` on every row, and the
 * declaration correspondingly drops its gitignore refusal rather than claiming a
 * branch that cannot run.
 *
 * @param projectRoot - The discovered project root, or `null` when there is none
 * @param cache - The run's projection store, or `undefined` to re-derive. A
 *   SEPARATE selector from the one above: which crawler answers membership and
 *   whether the answer is cached are independent choices, and conflating them
 *   would make the cache unmeasurable against the lane it is supposed to speed up
 * @param logger - Where the blob stage's refusals are reported. stderr, never
 *   stdout: this command's stdout is the YAML document a caller parses, and a
 *   diagnostic in the middle of it would break every consumer
 * @returns A population source, or `undefined` to use the walk
 */
function populationProviderFor(
	projectRoot: string | null,
	cache: PopulationCache | undefined,
	logger: Logger,
): SharedPopulationSource | undefined {
	if (!projectionCrawlSelected()) return undefined;
	if (projectRoot === null) return undefined;
	return async (skillMdPaths) => {
		const gitTracker = await gitTrackerForProjectRoot(projectRoot);
		return buildInventoryPopulation({
			root: projectRoot,
			skillMdPaths,
			// The observer this lane went without — see `populationWiring` for why
			// the reporting half is written once rather than per lane.
			...populationWiring(logger, gitTracker, cache),
		});
	};
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
