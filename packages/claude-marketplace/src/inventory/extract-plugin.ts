import { existsSync, type Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

import type {
	ComponentRef,
	DeclaredList,
	HookRef,
	LspRef,
	McpRef,
} from '@vibe-agent-toolkit/agent-skills';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { ClaudePluginSchema } from '../schemas/claude-plugin.js';

import { extractClaudeSkillInventory } from './extract-skill.js';
import { ClaudePluginInventory } from './types.js';

type ParseErrors = ClaudePluginInventory['parseErrors'];

const SKILL_MD = 'SKILL.md';
const PLUGIN_JSON = 'plugin.json';
const SHAPE_SKILL_CLAUDE_PLUGIN: 'skill-claude-plugin' = 'skill-claude-plugin';

/**
 * Build a PluginInventory for a directory containing a .claude-plugin/plugin.json manifest
 * and/or a root SKILL.md. Never throws — all failures surface via parseErrors[].
 */
export async function extractClaudePluginInventory(pluginPath: string): Promise<ClaudePluginInventory> {
	const absolute = safePath.resolve(pluginPath);

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute is resolved from caller-supplied path, safe for plugin extraction
	if (!existsSync(absolute)) {
		return new ClaudePluginInventory({
			path: absolute,
			shape: 'claude-plugin',
			manifest: {},
			declared: emptyDeclared(),
			discovered: { skills: [], commands: [], agents: [] },
			references: [],
			unexpected: { skillManifests: [], pluginManifests: [] },
			parseErrors: [{ path: absolute, message: `plugin path does not exist: ${absolute}` }],
		});
	}

	const parseErrors: ParseErrors = [];
	const manifestFilePath = safePath.join(absolute, '.claude-plugin', PLUGIN_JSON);
	const { rawManifest, manifest } = await readManifest(manifestFilePath, parseErrors);

	const rootSkillMd = safePath.join(absolute, SKILL_MD);
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
	const hasRootSkill = existsSync(rootSkillMd);
	const shape: ClaudePluginInventory['shape'] =
		rawManifest !== undefined && hasRootSkill ? SHAPE_SKILL_CLAUDE_PLUGIN : 'claude-plugin';

	const declared = buildDeclared(absolute, rawManifest);
	const discovered = await buildDiscovered(absolute, shape, rootSkillMd, parseErrors);
	const unexpected = await buildUnexpected(absolute, shape);

	return new ClaudePluginInventory({
		path: absolute,
		shape,
		manifest,
		declared,
		discovered,
		references: [], // Reserved for Chunk 3 detectors
		unexpected,
		parseErrors,
	});
}

type ManifestResult = {
	rawManifest: Record<string, unknown> | undefined;
	manifest: ClaudePluginInventory['manifest'];
};

async function readManifest(manifestFilePath: string, parseErrors: ParseErrors): Promise<ManifestResult> {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
	if (!existsSync(manifestFilePath)) {
		return { rawManifest: undefined, manifest: {} };
	}

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute path resolved from plugin root
	const raw = await readFile(manifestFilePath, 'utf-8').catch((e: unknown) => {
		parseErrors.push({ path: manifestFilePath, message: (e as Error).message });
		return null;
	});
	if (raw === null) return { rawManifest: undefined, manifest: {} };

	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch (e) {
		parseErrors.push({ path: manifestFilePath, message: (e as Error).message });
	}
	if (parsed === undefined) return { rawManifest: undefined, manifest: {} };

	const result = ClaudePluginSchema.safeParse(parsed);
	if (result.success) {
		const { name, version, description } = result.data;
		return {
			rawManifest: parsed,
			manifest: {
				name,
				...(version !== undefined && { version }),
				...(description !== undefined && { description }),
			},
		};
	}

	parseErrors.push({
		path: manifestFilePath,
		message: `plugin.json schema validation failed: ${result.error.issues.map(i => i.message).join('; ')}`,
	});
	return {
		rawManifest: parsed,
		manifest: {
			...(typeof parsed['name'] === 'string' && { name: parsed['name'] }),
			...(typeof parsed['version'] === 'string' && { version: parsed['version'] }),
			...(typeof parsed['description'] === 'string' && { description: parsed['description'] }),
		},
	};
}

function emptyDeclared(): ClaudePluginInventory['declared'] {
	return {
		skills: null,
		commands: null,
		agents: null,
		hooks: null,
		mcpServers: null,
		outputStyles: null,
		lspServers: null,
	};
}

function makeRef(base: string, manifestPath: string): ComponentRef {
	const resolved = safePath.resolve(base, manifestPath);
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from manifest path relative to validated plugin root
	return { manifestPath, resolvedPath: resolved, exists: existsSync(resolved) };
}

function normalizeComponentList(
	base: string,
	raw: unknown,
	keyPresent: boolean,
): DeclaredList<ComponentRef> {
	if (!keyPresent) return null;
	if (typeof raw === 'string') return [makeRef(base, raw)];
	if (Array.isArray(raw)) {
		if (raw.length === 0) return [];
		return raw.map(item => makeRef(base, String(item)));
	}
	// null, undefined, or object shape — treat as explicit empty
	return [];
}

function normalizeHookList<T extends HookRef>(
	base: string,
	raw: unknown,
	keyPresent: boolean,
	makeTyped: (ref: ComponentRef) => T,
): DeclaredList<T> {
	if (!keyPresent) return null;
	if (typeof raw === 'string') return [makeTyped(makeRef(base, raw))];
	if (Array.isArray(raw)) {
		if (raw.length === 0) return [];
		return raw.map(item => makeTyped(makeRef(base, String(item))));
	}
	if (typeof raw === 'object') {
		// Inline config object: manifestPath/resolvedPath empty; inline set on the ref
		const entry = makeTyped({ manifestPath: '', resolvedPath: '', exists: false });
		Object.assign(entry, { inline: raw ?? {} });
		return [entry];
	}
	return [];
}

function buildDeclared(
	base: string,
	raw: Record<string, unknown> | undefined,
): ClaudePluginInventory['declared'] {
	if (raw === undefined) return emptyDeclared();

	const has = (key: string): boolean => Object.hasOwn(raw, key);

	return {
		skills: normalizeComponentList(base, raw['skills'], has('skills')),
		commands: normalizeComponentList(base, raw['commands'], has('commands')),
		agents: normalizeComponentList(base, raw['agents'], has('agents')),
		outputStyles: normalizeComponentList(base, raw['outputStyles'], has('outputStyles')),
		hooks: normalizeHookList<HookRef>(base, raw['hooks'], has('hooks'), ref => ({ ...ref })),
		mcpServers: normalizeHookList<McpRef>(base, raw['mcpServers'], has('mcpServers'), ref => ({ ...ref })),
		lspServers: normalizeHookList<LspRef>(base, raw['lspServers'], has('lspServers'), ref => ({ ...ref })),
	};
}

async function buildDiscovered(
	absolute: string,
	shape: ClaudePluginInventory['shape'],
	rootSkillMd: string,
	parseErrors: ParseErrors,
): Promise<ClaudePluginInventory['discovered']> {
	const skills = await discoverSkills(absolute, shape, rootSkillMd, parseErrors);
	const commands = await discoverComponents(safePath.join(absolute, 'commands'));
	const agents = await discoverComponents(safePath.join(absolute, 'agents'));
	return { skills, commands, agents };
}

async function discoverSkills(
	absolute: string,
	shape: ClaudePluginInventory['shape'],
	rootSkillMd: string,
	parseErrors: ParseErrors,
) {
	const skillInventories = [];

	if (shape === SHAPE_SKILL_CLAUDE_PLUGIN) {
		const rootInv = await extractClaudeSkillInventory(rootSkillMd);
		for (const err of rootInv.parseErrors) parseErrors.push(err);
		skillInventories.push(rootInv);
	}

	const skillsDir = safePath.join(absolute, 'skills');
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
	if (!existsSync(skillsDir)) return skillInventories;

	let entries: string[] = [];
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
		entries = await readdir(skillsDir);
	} catch {
		// skip unreadable directory
	}
	for (const entry of entries) {
		const skillMd = safePath.join(skillsDir, entry, SKILL_MD);
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated skills directory
		if (existsSync(skillMd)) {
			const inv = await extractClaudeSkillInventory(skillMd);
			for (const err of inv.parseErrors) parseErrors.push(err);
			skillInventories.push(inv);
		}
	}

	return skillInventories;
}

/**
 * Walk a component directory (commands/ or agents/) and return one ComponentRef per .md file,
 * recursing into subdirectories. Every .md file in the tree is treated as a component ref.
 */
async function discoverComponents(dir: string): Promise<ComponentRef[]> {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
	if (!existsSync(dir)) return [];
	const refs: ComponentRef[] = [];
	const pluginRoot = safePath.resolve(safePath.join(dir, '..'));
	await walkComponentDir(dir, pluginRoot, refs);
	return refs;
}

async function walkComponentDir(
	currentDir: string,
	pluginRoot: string,
	refs: ComponentRef[],
): Promise<void> {
	let entries: Dirent<string>[];
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path recursively constructed from validated component directory
		entries = await readdir(currentDir, { withFileTypes: true, encoding: 'utf8' });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = safePath.join(currentDir, entry.name);
		const relPath = './' + safePath.relative(pluginRoot, fullPath);
		if (entry.isFile() && entry.name.endsWith('.md')) {
			refs.push({ manifestPath: relPath, resolvedPath: fullPath, exists: true });
		} else if (entry.isDirectory()) {
			await walkComponentDir(fullPath, pluginRoot, refs);
		}
	}
}

async function buildUnexpected(
	absolute: string,
	shape: ClaudePluginInventory['shape'],
): Promise<ClaudePluginInventory['unexpected']> {
	const [allSkillMds, allPluginJsons] = await Promise.all([
		crawlForPattern(absolute, SKILL_MD),
		crawlForPattern(absolute, PLUGIN_JSON),
	]);

	const rootSkillMd = safePath.join(absolute, SKILL_MD);
	const rootPluginJson = safePath.join(absolute, '.claude-plugin', PLUGIN_JSON);

	const skillManifests = allSkillMds.filter(p => {
		if (shape === SHAPE_SKILL_CLAUDE_PLUGIN && p === rootSkillMd) return false;
		const rel = toForwardSlash(safePath.relative(absolute, p));
		const parts = rel.split('/');
		return !(parts.length === 3 && parts[0] === 'skills' && parts[2] === SKILL_MD);
	});

	const pluginManifests = allPluginJsons.filter(
		p => p !== rootPluginJson && p.includes('/.claude-plugin/'),
	);

	return { skillManifests, pluginManifests };
}

/**
 * Recursively find all files with a given name under a directory.
 * Does not follow symlinks. Skips node_modules and .git.
 */
async function crawlForPattern(dir: string, filename: string): Promise<string[]> {
	const results: string[] = [];
	await crawlForPatternInner(dir, filename, results);
	return results;
}

async function crawlForPatternInner(
	currentDir: string,
	filename: string,
	results: string[],
): Promise<void> {
	let entries: Dirent<string>[];
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated base dir, recursively walking
		entries = await readdir(currentDir, { withFileTypes: true, encoding: 'utf8' });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = safePath.join(currentDir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			await crawlForPatternInner(fullPath, filename, results);
		} else if (entry.isFile() && entry.name === filename) {
			results.push(fullPath);
		}
	}
}
