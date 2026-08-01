import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
	parseFrontmatter,
	walkLinkGraph,
	type WalkableRegistry,
} from '@vibe-agent-toolkit/agent-skills';
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { crawlDirectory, findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';

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
 * Build a SkillInventory for a single SKILL.md.
 *
 * Consumes existing link-graph and frontmatter machinery — does not
 * re-walk or re-parse. Failures inside those parsers are surfaced via
 * parseErrors[]; nothing here throws on bad input.
 */
export async function extractClaudeSkillInventory(
	skillMdPath: string,
	sharedRegistry?: SharedRegistrySource,
): Promise<ClaudeSkillInventory> {
	const absolute = safePath.resolve(skillMdPath);
	const parseErrors: ParseErrors = [];

	const { name, description } = await parseFrontmatterFields(absolute, parseErrors);
	const linked = await walkLinkedFiles(absolute, parseErrors, sharedRegistry);

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
): Promise<string[]> {
	const linked: string[] = [];
	try {
		// Library fallback to skill dir; see plan 2026-05-17 / spec §7.
		const projectRoot = findProjectRoot(dirname(absolute)) ?? dirname(absolute);
		const registry = await registryFor(projectRoot, sharedRegistry);
		const skillResource = registry.getResource(absolute);
		if (skillResource !== undefined) {
			collectLinkedFiles(skillResource.id, registry, absolute, projectRoot, linked);
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

function collectLinkedFiles(
	skillId: string,
	registry: ResourceRegistry,
	absolute: string,
	projectRoot: string,
	linked: string[],
): void {
	const result = walkLinkGraph(skillId, registry as WalkableRegistry, {
		maxDepth: Infinity,
		excludeRules: [],
		projectRoot,
		skillRootPath: absolute,
		excludeNavigationFiles: true,
	});
	for (const r of result.bundledResources) {
		if (r.filePath !== absolute) linked.push(r.filePath);
	}
	for (const a of result.bundledAssets) {
		linked.push(a);
	}
}
