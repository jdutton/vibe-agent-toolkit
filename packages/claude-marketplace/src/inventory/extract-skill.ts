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
export async function extractClaudeSkillInventory(skillMdPath: string): Promise<ClaudeSkillInventory> {
	const absolute = safePath.resolve(skillMdPath);
	const parseErrors: ParseErrors = [];

	const { name, description } = await parseFrontmatterFields(absolute, parseErrors);
	const linked = await walkLinkedFiles(absolute, parseErrors);

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

async function walkLinkedFiles(absolute: string, parseErrors: ParseErrors): Promise<string[]> {
	const linked: string[] = [];
	try {
		const projectRoot = findProjectRoot(dirname(absolute));
		// Crawl with respectGitignore: false so untracked skills and linked documents
		// that the user is actively authoring are included alongside committed files.
		const files = await crawlDirectory({
			baseDir: projectRoot,
			include: ['**/*.md'],
			absolute: true,
			filesOnly: true,
			respectGitignore: false,
		});
		const registry = new ResourceRegistry({ baseDir: projectRoot });
		await registry.addResources(files);
		registry.resolveLinks();
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
