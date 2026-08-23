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
	type ClaudeSkillInventoryOptions,
	type GitTrackerSource,
	type SharedRegistrySource,
} from './extract-skill.js';
import { type InventoryPopulation, type SharedPopulationSource } from './inventory-population.js';
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
 * What {@link extractClaudePluginInventory} needs besides the plugin path.
 *
 * The skill extractor's options with ONE member re-typed. Everything this lane
 * does is hand its options down, so it inherits rather than copies — a second
 * declaration of the shared members could only ever drift from the one that
 * actually governs the walk.
 *
 * `sharedPopulation` is the exception, and the divergence is structural rather
 * than stylistic: this layer holds the skill list and so takes a SOURCE, while
 * the skill extractor takes the resolved population. See the member's own note.
 *
 * Its `gitTrackerSource` is REQUIRED for the reason the skill extractor's is —
 * see {@link ClaudeSkillInventoryOptions}. A plugin lane that genuinely has no
 * tracker to offer says {@link NO_GIT_TRACKER}, and the tracker-less walk is
 * then a choice at the call site rather than an omission three functions away.
 */
export interface ClaudePluginInventoryOptions
	extends Omit<ClaudeSkillInventoryOptions, 'sharedPopulation'> {
	/**
	 * Optional projection-backed membership lane — see {@link SharedPopulationSource}.
	 *
	 * A SOURCE here, where the skill extractor takes a resolved population: a
	 * population must register one contributor per skill before it runs, and this
	 * is the layer that knows the skill list. The skill extractor never could.
	 */
	sharedPopulation?: SharedPopulationSource | undefined;
}

/**
 * Build a PluginInventory for a directory containing a .claude-plugin/plugin.json manifest
 * and/or a root SKILL.md. Never throws — all failures surface via parseErrors[].
 */
export async function extractClaudePluginInventory(
	pluginPath: string,
	options: ClaudePluginInventoryOptions,
): Promise<ClaudePluginInventory> {
	const { sharedRegistry, sharedPopulation, gitTrackerSource } = options;
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
		sharedPopulation,
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
	gitTrackerSource: GitTrackerSource,
	sharedPopulation: SharedPopulationSource | undefined,
): Promise<ClaudePluginInventory['discovered']> {
	const skills = await discoverSkills(
		absolute,
		shape,
		rootSkillMd,
		parseErrors,
		resolveSharedRegistry,
		gitTrackerSource,
		sharedPopulation,
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
	gitTrackerSource: GitTrackerSource,
	sharedPopulation: SharedPopulationSource | undefined,
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
	//
	// It is passed STRAIGHT THROUGH, with no `?? NO_GIT_TRACKER` behind it. That
	// coalesce used to live here, and it was the join where required-ness stopped:
	// the skill extractor demanded a source, this function's own parameter was
	// optional, and the fallback quietly turned every omission back into the
	// tracker-less walk. The lanes that omitted it were the ones that matter —
	// `extract-install.ts` (`vat inventory --user`, every cached plugin) and
	// `extract-marketplace.ts` (which had no parameter to pass on at all) — so
	// "the skill extractor requires a source" was a statement about one file
	// rather than about the lane. Both now carry the obligation to their own
	// callers, and a lane that wants no tracker names `NO_GIT_TRACKER`.
	const skillMdPaths = await collectSkillMdPaths(absolute, shape, rootSkillMd);

	// Resolved ONCE, here, because this is the first layer that knows the whole
	// skill list — and a population must register a contributor per skill before it
	// runs, so unlike the registry it cannot be deferred any further down. Resolved
	// only when discovery actually found a skill, for the same reason the registry
	// provider is handed over unresolved: a plugin of commands/ and agents/ alone
	// must populate nothing.
	//
	// A source that throws degrades to the incumbent rather than failing the
	// plugin — but it SAYS SO, and the difference is not cosmetic.
	//
	// This was a bare `catch { population = undefined; }`, written when the lane
	// was an opt-in second implementation of a question the walk already answers,
	// so its failure was "a missing measurement, not a defect in the subject".
	// That premise expired twice over: the projection is now this command's
	// DEFAULT membership answer, and the source behind it writes an
	// EXPLICITLY OPTED-IN cache (`VAT_PROJECTION_STORE`). Silence turned a hard
	// store failure into a run that exited 0, cached nothing, and paid the
	// projection AND the walk — on every root shipping a binary file, for as long
	// as the store rejected a declined blob. Measured on a real adopter plugin:
	// 76 s cold, then 76 s again warm, with an empty store; the same run reports
	// 1.3 s warm once the store can actually be written.
	// `cli/src/utils/projection-store.ts` states the standard in its own header:
	// an opted-in cache that quietly does nothing is worse than no cache.
	//
	// A warning and not a `parseErrors` entry, and not a throw:
	//
	// - `parseErrors` is this module's degradation channel for defects in the
	//   SUBJECT, and `audit.ts` renders every entry as an error-severity
	//   `PLUGIN_INVALID_JSON` finding. A cache failure is neither invalid JSON
	//   nor the plugin's fault, and routing it there would fail an audit over it.
	// - A throw would break "never throws — all failures surface via
	//   parseErrors[]", which `audit.ts` depends on by name: it records the
	//   incident where moving a crawl outside this catch aborted a whole audit
	//   with exit code 2 instead of degrading three link walks.
	//
	// So the failure is loud on stderr and the extraction continues, which is the
	// same posture `projection-store.ts` takes when it cannot key a tree.
	let population: InventoryPopulation | undefined;
	if (sharedPopulation !== undefined && skillMdPaths.length > 0) {
		try {
			population = await sharedPopulation(skillMdPaths);
		} catch (error) {
			population = undefined;
			console.warn(
				`[vat] Warning: the projection membership lane failed for ${absolute}, so this`
				+ ` plugin's skills fell back to the link walk and nothing was cached: ${String(error)}`,
			);
		}
	}

	for (const skillMd of skillMdPaths) {
		const inv = await extractClaudeSkillInventory(skillMd, {
			sharedRegistry: resolveSharedRegistry,
			gitTrackerSource,
			...(population !== undefined && { sharedPopulation: population }),
		});
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
