import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
	parseFrontmatter,
	walkLinkGraph,
	type WalkableRegistry,
} from '@vibe-agent-toolkit/agent-skills';
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import {
	CRAWL_REGISTRY_ENUMERATE_ID,
	crawlDirectory,
	crawlTimingStart,
	findProjectRoot,
	type GitTracker,
	recordRegistryPass,
	safePath,
} from '@vibe-agent-toolkit/utils';

import { type InventoryPopulation } from './inventory-population.js';
import { ClaudeSkillInventory } from './types.js';

type ParseErrors = ClaudeSkillInventory['parseErrors'];

/**
 * A registry to link-walk against, or a way to obtain one.
 *
 * Pass the provider form when building the registry is expensive and the caller
 * cannot tell in advance whether it is needed: a registry costs a whole-corpus
 * crawl, and a plugin of only commands/ and agents/ walks no links at all.
 *
 * The provider is invoked from INSIDE the link walk's try/catch, which is what
 * keeps both extractors' "never throws" contract intact: a crawl that fails
 * (one unreadable markdown file under the root is enough) degrades that skill's
 * `files.linked` to empty and surfaces as a parseErrors entry, exactly as it did
 * when the crawl was unconditionally inline.
 */
export type SharedRegistrySource =
	| ResourceRegistry
	| (() => Promise<ResourceRegistry | undefined>);

/**
 * A way to obtain the {@link GitTracker} covering one link walk's `projectRoot`.
 *
 * Handed to {@link walkLinkGraph}, a tracker turns each link target's gitignore
 * question into an O(1) active-set lookup instead of a `git check-ignore`
 * subprocess per distinct target.
 *
 * Measured 2026-08-09 — **two different corpora, kept apart on purpose, because
 * quoting them side by side reads as one run:**
 *
 * - *A 1,484-document adopter monorepo.* `vat audit` spawned 786 `check-ignore`
 *   processes, every one of them from this lane. Over that same 785-path
 *   population the two oracles cost 9,242 ms and 148 ms respectively, and
 *   disagreed on nothing.
 * - *`vat audit --user`, real installed plugins.* 715 spawns → 0, with the
 *   2,788,833-byte report byte-identical apart from its `duration:` line.
 *
 * ⚠️ Neither bullet is a whole-command speed claim: the after-runs were taken on
 * a loaded machine and are not comparable to the before-runs. The defensible
 * numbers are the spawn counts and the isolated oracle timing.
 *
 * ## Why a function of the root, not a tracker
 *
 * Each skill's `projectRoot` is discovered per skill (`findProjectRoot` from the
 * SKILL.md's directory), and one run routinely spans many roots — `vat audit
 * --user` reached at least 72 distinct root directories in a single measured run
 * (counted as distinct resolved paths, so it is a lower bound on the number of
 * distinct root *spellings*). A tracker answers only about the repository it was
 * initialized for, so the extractor must be able to ask per root.
 *
 * ## The caller owns the cache
 *
 * This package never builds or caches trackers: initialization spawns
 * `git ls-files`, and the caller already has the cache that must be shared with
 * the rest of its scan (`getOrCreateGitTracker` in the CLI's audit lane). Return
 * `undefined` for a root you cannot or do not want to answer for — the walk then
 * falls back to the `git check-ignore` oracle, exactly as {@link NO_GIT_TRACKER}
 * does for every root.
 *
 * That is also why the source is REQUIRED rather than defaulted: the obligation
 * belongs to the caller that owns the cache, and having the extractor build its
 * own tracker would both reverse this decision and walk straight into the
 * staleness hazard below. See {@link NO_GIT_TRACKER} for choosing the
 * tracker-less walk on purpose.
 *
 * ## Staleness bound — safe for read-only lanes only
 *
 * A tracker snapshots `git ls-files` at `initialize()`. A file created AFTER
 * that snapshot exists on disk but is absent from the active set, so
 * `isIgnoredByActiveSet` reports it **ignored**. That is safe for inventory and
 * audit, which only read; it is NOT safe for a lane that writes between walks
 * (`packageSkill` writes `dist/` per skill), which must build a fresh tracker or
 * pass {@link NO_GIT_TRACKER}.
 *
 * ⚠️ "Safe" here means the read-only lane cannot corrupt anything — NOT that the
 * two oracles agree. They demonstrably do not: a post-snapshot file is `ignored`
 * to the active set and not ignored to `git check-ignore`, so the same skill's
 * `files.linked` differs by that file depending on which oracle answered. The
 * divergence suite in `test/inventory/extract-skill.test.ts` pins exactly that
 * pair of answers, and is the only thing in this package's tests that can.
 */
export type GitTrackerSource = (projectRoot: string) => Promise<GitTracker | undefined>;

/**
 * The {@link GitTrackerSource} that answers for nothing — the explicit spelling
 * of "walk this skill with no tracker".
 *
 * Naming it is the point. A caller that genuinely has no tracker to offer says
 * so at the call site, in a form that greps, instead of arriving in that state
 * by leaving an argument off.
 */
export const NO_GIT_TRACKER: GitTrackerSource = async () => undefined;

/**
 * What {@link extractClaudeSkillInventory} needs besides the skill path.
 *
 * An options object rather than two more positionals: both members are
 * FUNCTIONS of similar shape, so a positional pair is exactly the arrangement a
 * caller can silently transpose. It also lets the required member sit after the
 * optional one, which positional parameters cannot express — `sharedRegistry`
 * was already optional when `gitTrackerSource` had to become required.
 */
export interface ClaudeSkillInventoryOptions {
	/**
	 * REQUIRED. How to obtain the tracker for whatever project root this walk
	 * lands on; pass {@link NO_GIT_TRACKER} to choose the tracker-less walk.
	 *
	 * ⚠️ Required-ness does not eliminate the tracker-less state, and is not
	 * claimed to: this source may still return `undefined` for a root, and
	 * `gitTrackerFor` deliberately swallows a source that throws (a failing
	 * source is a missing optimization, not a defect in the skill). What it buys
	 * is that the state is now CHOSEN rather than defaulted into — and, in
	 * particular, that a test cannot land in it by omission. That omission is how
	 * the divergence this parameter governs stayed hidden: a projection's
	 * `gitignored` column is filled only from a tracker that was handed in, while
	 * the incumbent walker falls back to `git check-ignore` per link target, so a
	 * no-tracker fixture produced walker=3 against closure=5 linked files.
	 */
	gitTrackerSource: GitTrackerSource;
	/** Optional pre-crawled registry (or a way to get one) — see {@link SharedRegistrySource}. */
	sharedRegistry?: SharedRegistrySource;
	/**
	 * Optional pre-populated projection to answer membership from INSTEAD of the
	 * link walk — see {@link InventoryPopulation}.
	 *
	 * Already resolved, unlike `sharedRegistry`: a population must know every
	 * skill before it runs, so only a caller holding the whole list can build one,
	 * and deferring it to here would defer it past the point the list is known.
	 *
	 * Supplying it does not force its use. It is honoured only for a population
	 * rooted at exactly this skill's `projectRoot`, and only when that population
	 * holds an extent for this skill; anything else falls back to the walk.
	 */
	sharedPopulation?: InventoryPopulation | undefined;
}

/**
 * Build a SkillInventory for a single SKILL.md.
 *
 * Consumes existing link-graph and frontmatter machinery — does not
 * re-walk or re-parse. Failures inside those parsers are surfaced via
 * parseErrors[]; nothing here throws on bad input.
 */
export async function extractClaudeSkillInventory(
	skillMdPath: string,
	options: ClaudeSkillInventoryOptions,
): Promise<ClaudeSkillInventory> {
	const absolute = safePath.resolve(skillMdPath);
	const parseErrors: ParseErrors = [];

	const { name, description } = await parseFrontmatterFields(absolute, parseErrors);
	const linked = await walkLinkedFiles(absolute, parseErrors, options);

	return new ClaudeSkillInventory({
		path: absolute,
		manifest: { name, ...(description !== undefined && { description }) },
		files: { skillMd: absolute, linked, packaged: [] },
		parseErrors,
	});
}

async function parseFrontmatterFields(
	absolute: string,
	parseErrors: ParseErrors,
): Promise<{ name: string; description: string | undefined }> {
	let name = '';
	let description: string | undefined;
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute is resolved from caller-supplied path, safe for skill extraction
		const raw = await readFile(absolute, 'utf-8');
		const parsed = parseFrontmatter(raw);
		if (parsed.success) {
			const fm = parsed.frontmatter;
			if (typeof fm['name'] === 'string') name = fm['name'];
			if (typeof fm['description'] === 'string') description = fm['description'];
		} else {
			parseErrors.push({ path: absolute, message: parsed.error });
		}
	} catch (e) {
		parseErrors.push({ path: absolute, message: (e as Error).message });
	}
	return { name, description };
}

/**
 * Crawl + link-resolve a registry covering `projectRoot`.
 *
 * Untracked skills and linked documents the user is actively authoring must be
 * included alongside committed files. Ask git that narrower question
 * (`includeUntracked`) rather than `respectGitignore: false`, which
 * additionally pulls in every ignored tree AND abandons `git ls-files` for a
 * full recursive walk — 39.6 s versus 16 ms for the same file set on a
 * ~1,200-document monorepo.
 *
 * ## Why the enumeration is bracketed HERE and not inside `ResourceRegistry`
 *
 * The other five registry-construction routes go through `ResourceRegistry.crawl`,
 * whose own `crawlDirectory` call the seam already brackets. This route does not:
 * it enumerates for itself and hands the paths to `addResources`, so its
 * enumeration sits outside the class and outside that bracket, and
 * `resources/test/crawl-timing.test.ts` pins that absence at the class level
 * deliberately.
 *
 * Left unbracketed, this is a ONE-SIDED under-count rather than a symmetric one:
 * it is the registry the INCUMBENT walker consumes and the projection never
 * builds, so every millisecond of it was missing from exactly the arm the flip
 * decision is being taken against. It files the same `resource-registry:enumerate`
 * row the class does — the same accounting unit, and the two never both run for
 * one registry, so they cannot double-charge each other.
 *
 * `recordRegistryPass` rather than a stratum named here, for the reason that
 * function states: this route is reachable from a projection contributor in
 * principle, and a call site that names an arm it cannot know is how one arm's
 * work lands on the other's total.
 */
export async function crawlSkillLinkRegistry(projectRoot: string): Promise<ResourceRegistry> {
	const enumerationStartedAt = crawlTimingStart();
	const files = await crawlDirectory({
		baseDir: projectRoot,
		include: ['**/*.md'],
		absolute: true,
		filesOnly: true,
		includeUntracked: true,
	});
	recordRegistryPass(CRAWL_REGISTRY_ENUMERATE_ID, enumerationStartedAt);
	const registry = new ResourceRegistry({ baseDir: projectRoot });
	await registry.addResources(files);
	registry.resolveLinks();
	return registry;
}

async function walkLinkedFiles(
	absolute: string,
	parseErrors: ParseErrors,
	options: ClaudeSkillInventoryOptions,
): Promise<string[]> {
	const linked: string[] = [];
	try {
		// Library fallback to skill dir; see plan 2026-05-17 / spec §7.
		const projectRoot = findProjectRoot(dirname(absolute)) ?? dirname(absolute);

		// The projection lane, when one was supplied for exactly this root. Ahead of
		// the registry so the incumbent's whole-corpus crawl is not paid and then
		// discarded — the point of the lane is that it replaces that crawl, and a
		// version that ran both would measure neither.
		const projected = membersFromPopulation(projectRoot, absolute, options.sharedPopulation);
		if (projected !== undefined) return [...projected];

		const registry = await registryFor(projectRoot, options.sharedRegistry);
		const skillResource = registry.getResource(absolute);
		if (skillResource !== undefined) {
			const gitTracker = await gitTrackerFor(projectRoot, options.gitTrackerSource);
			collectLinkedFiles(skillResource.id, registry, absolute, projectRoot, linked, gitTracker);
		}
	} catch (e) {
		parseErrors.push({ path: absolute, message: `link walk failed: ${(e as Error).message}` });
	}
	return linked;
}

/**
 * This skill's membership from a supplied population, or `undefined` to fall back
 * to the walk.
 *
 * Two independent guards, and both have to hold:
 *
 * 1. **Exact-root equality**, the same rule and the same reason as
 *    {@link registryFor}: membership is resolved relative to a root, so a
 *    population rooted elsewhere answers a different question. Ancestry is not
 *    enough.
 * 2. **The population holds an extent for this skill.** A population built from a
 *    stale skill list — one skill added since — would otherwise report that skill
 *    as having no linked files, which is a confident wrong answer rather than a
 *    missing one. `membersOf` returns `undefined` for that case and an empty array
 *    for a skill that genuinely links to nothing, and the two must not be
 *    conflated here.
 *
 * @param projectRoot - The root this skill's walk resolves against
 * @param skillMdPath - Absolute path to the skill's SKILL.md
 * @param population - The caller's population, if any
 * @returns Absolute linked-file paths, or `undefined` when the walk must run
 */
function membersFromPopulation(
	projectRoot: string,
	skillMdPath: string,
	population: InventoryPopulation | undefined,
): readonly string[] | undefined {
	if (population === undefined) return undefined;
	if (safePath.resolve(population.root) !== safePath.resolve(projectRoot)) return undefined;
	return population.membersOf(skillMdPath);
}

/**
 * The registry to walk `projectRoot` with: the caller's, if it was crawled for exactly
 * this root, otherwise a fresh one.
 *
 * Building one means parsing every document under the root, so a caller walking many
 * skills (`vat audit`, `vat inventory <plugin>`) would otherwise pay that once per skill.
 * Exact-root equality, not ancestry: `collectLinkedFiles` walks relative to `projectRoot`,
 * so a registry rooted elsewhere would answer a different question.
 *
 * Only the caller can make those roots agree — a provider rooted somewhere else is
 * resolved (paying its crawl) and then discarded here, which is strictly worse than
 * passing nothing.
 */
async function registryFor(
	projectRoot: string,
	sharedRegistry: SharedRegistrySource | undefined,
): Promise<ResourceRegistry> {
	const shared = typeof sharedRegistry === 'function' ? await sharedRegistry() : sharedRegistry;
	const sharedBaseDir = shared?.baseDir;
	if (
		shared !== undefined
		&& sharedBaseDir !== undefined
		&& safePath.resolve(sharedBaseDir) === safePath.resolve(projectRoot)
	) {
		return shared;
	}
	return crawlSkillLinkRegistry(projectRoot);
}

/**
 * The tracker for this walk, or `undefined` when the source could not answer.
 *
 * There is no longer a "caller supplied no source" case — the source is a
 * required option — but there are still two ways to end up without a tracker:
 * the source returns `undefined` for this root, or it throws. A source that
 * fails is a MISSING OPTIMIZATION, not a bad skill: the walk still produces its
 * answer, one `git check-ignore` per link target instead of an active-set
 * lookup. So the throw is swallowed here rather than allowed to reach
 * `walkLinkedFiles`'s catch, which would file it as a `link walk failed`
 * parseError against the skill's own path — a fabricated defect in a file that
 * has none.
 *
 * ⚠️ Both remaining routes produce the SAME walk the missing argument used to,
 * so required-ness narrows who can arrive here by accident; it does not close
 * the state. `NO_GIT_TRACKER` is the third, deliberate route.
 */
async function gitTrackerFor(
	projectRoot: string,
	gitTrackerSource: GitTrackerSource,
): Promise<GitTracker | undefined> {
	try {
		return await gitTrackerSource(projectRoot);
	} catch {
		return undefined;
	}
}

function collectLinkedFiles(
	skillId: string,
	registry: ResourceRegistry,
	absolute: string,
	projectRoot: string,
	linked: string[],
	gitTracker: GitTracker | undefined,
): void {
	// Conditional assignment, not `gitTracker: undefined`. ⚠️ The reason is a TYPE
	// reason, not a runtime one — an earlier version of this comment claimed the
	// walker's no-tracker branch keys on the KEY'S ABSENCE, and it does not:
	// `walk-link-graph.ts` reads `options.gitTracker === undefined`, which absence
	// and an explicit `undefined` both satisfy, and it never uses `in`. What
	// actually forbids the literal is `exactOptionalPropertyTypes`, under which
	// assigning `undefined` to an optional property is a compile error. The object
	// still ends up key-for-key identical to the pre-tracker one whenever no
	// tracker is in hand — which, now that the source is required, means a source
	// that declined or threw rather than an argument nobody passed.
	const walkOptions: Parameters<typeof walkLinkGraph>[2] = {
		maxDepth: Infinity,
		excludeRules: [],
		projectRoot,
		skillRootPath: absolute,
		excludeNavigationFiles: true,
	};
	if (gitTracker !== undefined) {
		walkOptions.gitTracker = gitTracker;
	}
	const result = walkLinkGraph(skillId, registry as WalkableRegistry, walkOptions);
	for (const r of result.bundledResources) {
		if (r.filePath !== absolute) linked.push(r.filePath);
	}
	for (const a of result.bundledAssets) {
		linked.push(a);
	}
}
