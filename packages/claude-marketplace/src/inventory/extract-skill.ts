import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
	parseFrontmatter,
	walkLinkGraph,
	type WalkableRegistry,
} from '@vibe-agent-toolkit/agent-skills';
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { crawlDirectory, findProjectRoot, safePath, type GitTracker } from '@vibe-agent-toolkit/utils';

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
 * behaves exactly as it does with no source at all.
 *
 * ## Staleness bound — safe for read-only lanes only
 *
 * A tracker snapshots `git ls-files` at `initialize()`. A file created AFTER
 * that snapshot exists on disk but is absent from the active set, so
 * `isIgnoredByActiveSet` reports it **ignored**. That is safe for inventory and
 * audit, which only read; it is NOT safe for a lane that writes between walks
 * (`packageSkill` writes `dist/` per skill), which must build a fresh tracker or
 * pass none.
 */
export type GitTrackerSource = (projectRoot: string) => Promise<GitTracker | undefined>;

/**
 * Build a SkillInventory for a single SKILL.md.
 *
 * Consumes existing link-graph and frontmatter machinery — does not
 * re-walk or re-parse. Failures inside those parsers are surfaced via
 * parseErrors[]; nothing here throws on bad input.
 */
export async function extractClaudeSkillInventory(
	skillMdPath: string,
	sharedRegistry?: SharedRegistrySource,
	gitTrackerSource?: GitTrackerSource,
): Promise<ClaudeSkillInventory> {
	const absolute = safePath.resolve(skillMdPath);
	const parseErrors: ParseErrors = [];

	const { name, description } = await parseFrontmatterFields(absolute, parseErrors);
	const linked = await walkLinkedFiles(absolute, parseErrors, sharedRegistry, gitTrackerSource);

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
 */
export async function crawlSkillLinkRegistry(projectRoot: string): Promise<ResourceRegistry> {
	const files = await crawlDirectory({
		baseDir: projectRoot,
		include: ['**/*.md'],
		absolute: true,
		filesOnly: true,
		includeUntracked: true,
	});
	const registry = new ResourceRegistry({ baseDir: projectRoot });
	await registry.addResources(files);
	registry.resolveLinks();
	return registry;
}

async function walkLinkedFiles(
	absolute: string,
	parseErrors: ParseErrors,
	sharedRegistry?: SharedRegistrySource,
	gitTrackerSource?: GitTrackerSource,
): Promise<string[]> {
	const linked: string[] = [];
	try {
		// Library fallback to skill dir; see plan 2026-05-17 / spec §7.
		const projectRoot = findProjectRoot(dirname(absolute)) ?? dirname(absolute);
		const registry = await registryFor(projectRoot, sharedRegistry);
		const skillResource = registry.getResource(absolute);
		if (skillResource !== undefined) {
			const gitTracker = await gitTrackerFor(projectRoot, gitTrackerSource);
			collectLinkedFiles(skillResource.id, registry, absolute, projectRoot, linked, gitTracker);
		}
	} catch (e) {
		parseErrors.push({ path: absolute, message: `link walk failed: ${(e as Error).message}` });
	}
	return linked;
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
 * The tracker for this walk, or `undefined` when the caller supplied no source
 * or the source could not answer.
 *
 * A source that fails is a MISSING OPTIMIZATION, not a bad skill: the walk still
 * produces the same answer, one `git check-ignore` per link target instead of an
 * active-set lookup. So the throw is swallowed here rather than allowed to reach
 * `walkLinkedFiles`'s catch, which would file it as a `link walk failed`
 * parseError against the skill's own path — a fabricated defect in a file that
 * has none.
 */
async function gitTrackerFor(
	projectRoot: string,
	gitTrackerSource: GitTrackerSource | undefined,
): Promise<GitTracker | undefined> {
	if (gitTrackerSource === undefined) return undefined;
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
	// still ends up key-for-key identical to the pre-change one when no source is
	// supplied, which is the property this bite is held to.
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
