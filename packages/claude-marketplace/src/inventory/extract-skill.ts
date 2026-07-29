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
 * Build a SkillInventory for a single SKILL.md.
 *
 * Consumes existing link-graph and frontmatter machinery — does not
 * re-walk or re-parse. Failures inside those parsers are surfaced via
 * parseErrors[]; nothing here throws on bad input.
 */
export async function extractClaudeSkillInventory(
	skillMdPath: string,
	sharedRegistry?: ResourceRegistry,
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
	sharedRegistry?: ResourceRegistry,
): Promise<string[]> {
	const linked: string[] = [];
	try {
		// Library fallback to skill dir; see plan 2026-05-17 / spec §7.
		const projectRoot = findProjectRoot(dirname(absolute)) ?? dirname(absolute);
		// Reuse the caller's registry when it was crawled for exactly this root.
		// Building one means parsing every document under the root, so a caller
		// walking many skills (`vat audit`) would otherwise pay that once per
		// skill. Exact-root equality, not ancestry: `collectLinkedFiles` walks
		// relative to `projectRoot`, so a registry rooted elsewhere would answer
		// a different question.
		const sharedBaseDir = sharedRegistry?.baseDir;
		const registry = sharedRegistry !== undefined
			&& sharedBaseDir !== undefined
			&& safePath.resolve(sharedBaseDir) === safePath.resolve(projectRoot)
			? sharedRegistry
			: await crawlSkillLinkRegistry(projectRoot);
		const skillResource = registry.getResource(absolute);
		if (skillResource !== undefined) {
			collectLinkedFiles(skillResource.id, registry, absolute, projectRoot, linked);
		}
	} catch (e) {
		parseErrors.push({ path: absolute, message: `link walk failed: ${(e as Error).message}` });
	}
	return linked;
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
