import { existsSync, type Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

import type {
	ComponentRef,
	DeclaredList,
	HookRef,
	LspRef,
	McpRef,
} from '@vibe-agent-toolkit/agent-skills';
import type { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { ClaudePluginSchema } from '../schemas/claude-plugin.js';

import {
	extractClaudeSkillInventory,
	type GitTrackerSource,
	type SharedRegistrySource,
} from './extract-skill.js';
import { ClaudePluginInventory, type ClaudeSkillInventory } from './types.js';

type ParseErrors = ClaudePluginInventory['parseErrors'];

const SKILL_MD = 'SKILL.md';
const PLUGIN_JSON = 'plugin.json';
const SHAPE_SKILL_CLAUDE_PLUGIN = 'skill-claude-plugin' as const;

/**
 * Resolve a {@link SharedRegistrySource} on first use, then reuse that answer — including
 * a rejection.
 *
 * Every skill in the plugin link-walks against the same registry, so the whole-corpus
 * crawl behind it must happen at most once. Caching the rejected promise too means a
 * crawl that failed is not retried once per skill: each skill still reports the failure
 * against its own path (its `files.linked` really is degraded), but the cost is paid once.
 */
function memoizeSharedRegistry(
	source: SharedRegistrySource | undefined,
): () => Promise<ResourceRegistry | undefined> {
	if (typeof source !== 'function') return async () => source;
	let pending: Promise<ResourceRegistry | undefined> | undefined;
	return async () => (pending ??= source());
}

/**
 * Build a PluginInventory for a directory containing a .claude-plugin/plugin.json manifest
 * and/or a root SKILL.md. Never throws — all failures surface via parseErrors[].
 */
export async function extractClaudePluginInventory(
	pluginPath: string,
	sharedRegistry?: SharedRegistrySource,
	gitTrackerSource?: GitTrackerSource,
): Promise<ClaudePluginInventory> {
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
	const discovered = await buildDiscovered(
		absolute,
		shape,
		rootSkillMd,
		parseErrors,
		memoizeSharedRegistry(sharedRegistry),
		gitTrackerSource,
	);
	const unexpected = await buildUnexpected(absolute, shape);

	await collectAssetParseErrors(absolute, parseErrors);

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
	resolveSharedRegistry: () => Promise<ResourceRegistry | undefined>,
	gitTrackerSource: GitTrackerSource | undefined,
): Promise<ClaudePluginInventory['discovered']> {
	const skills = await discoverSkills(
		absolute,
		shape,
		rootSkillMd,
		parseErrors,
		resolveSharedRegistry,
		gitTrackerSource,
	);
	const commands = await discoverComponents(safePath.join(absolute, 'commands'));
	const agents = await discoverComponents(safePath.join(absolute, 'agents'));
	return { skills, commands, agents };
}

async function discoverSkills(
	absolute: string,
	shape: ClaudePluginInventory['shape'],
	rootSkillMd: string,
	parseErrors: ParseErrors,
	resolveSharedRegistry: () => Promise<ResourceRegistry | undefined>,
	gitTrackerSource: GitTrackerSource | undefined,
): Promise<ClaudeSkillInventory[]> {
	const skillInventories: ClaudeSkillInventory[] = [];

	// The provider is handed to the skill extractor UNRESOLVED, so the crawl happens
	// inside its link-walk try/catch and a failure degrades to parseErrors instead of
	// escaping this function — which documents that it never throws. It is also only
	// ever reached from inside this loop, so a plugin owning no SKILL.md never asks for
	// a registry: discovery decides, and the caller does not have to predict what
	// discovery will find.
	//
	// `gitTrackerSource` rides the same channel but is NOT memoized here: it is a
	// function of each skill's own project root (skills under one plugin can sit in
	// different repositories), and the caller — not this package — owns the per-root
	// cache behind it.
	for (const skillMd of await collectSkillMdPaths(absolute, shape, rootSkillMd)) {
		const inv = await extractClaudeSkillInventory(skillMd, resolveSharedRegistry, gitTrackerSource);
		for (const err of inv.parseErrors) parseErrors.push(err);
		skillInventories.push(inv);
	}

	return skillInventories;
}

/**
 * Every SKILL.md this plugin owns, in extraction order: the root skill (skill-claude-plugin
 * shape only) first, then each `skills/<name>/SKILL.md`.
 */
async function collectSkillMdPaths(
	absolute: string,
	shape: ClaudePluginInventory['shape'],
	rootSkillMd: string,
): Promise<string[]> {
	const paths: string[] = [];
	if (shape === SHAPE_SKILL_CLAUDE_PLUGIN) paths.push(rootSkillMd);

	const skillsDir = safePath.join(absolute, 'skills');
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
	if (!existsSync(skillsDir)) return paths;

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
		if (existsSync(skillMd)) paths.push(skillMd);
	}

	return paths;
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
	const matches = await crawlForFilenames(absolute, [SKILL_MD, PLUGIN_JSON]);
	const allSkillMds = matches.get(SKILL_MD) ?? [];
	const allPluginJsons = matches.get(PLUGIN_JSON) ?? [];

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
 * Try parsing hooks/hooks.json and .mcp.json. Any JSON syntax error is
 * appended to `parseErrors` as a PLUGIN_INVALID_JSON-compatible record;
 * missing files are silently skipped.
 */
async function collectAssetParseErrors(absolute: string, parseErrors: ParseErrors): Promise<void> {
	const checks: Array<{ path: string; label: string }> = [
		{ path: safePath.join(absolute, 'hooks', 'hooks.json'), label: 'hooks/hooks.json' },
		{ path: safePath.join(absolute, '.mcp.json'), label: '.mcp.json' },
	];

	for (const { path, label } of checks) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
		if (!existsSync(path)) continue;
		let raw: string;
		try {
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated absolute plugin root
			raw = await readFile(path, 'utf-8');
		} catch {
			continue;
		}
		try {
			JSON.parse(raw);
		} catch (e) {
			parseErrors.push({ path, message: `${label} is not valid JSON: ${(e as Error).message}` });
		}
	}
}

/**
 * Recursively find all files matching any of `filenames`, keyed by filename. Every key is
 * present in the returned map, mapping to `[]` when nothing matched. Does not follow
 * symlinks. Skips node_modules and .git.
 *
 * One walk answers every filename. The directory entries are already in hand, so matching
 * an extra name is a string comparison — crawling per filename instead read each directory
 * once per pattern, which for the two names below meant reading the entire plugin tree
 * twice. Keep new patterns inside this walk rather than adding a second call.
 */
async function crawlForFilenames(
	dir: string,
	filenames: readonly string[],
): Promise<Map<string, string[]>> {
	const results = new Map<string, string[]>(filenames.map(name => [name, []]));
	await crawlForFilenamesInner(dir, results);
	return results;
}

async function crawlForFilenamesInner(
	currentDir: string,
	results: Map<string, string[]>,
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
			await crawlForFilenamesInner(fullPath, results);
		} else if (entry.isFile()) {
			results.get(entry.name)?.push(fullPath);
		}
	}
}
