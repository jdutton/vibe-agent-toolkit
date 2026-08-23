import { writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';

import { mkdirSyncReal, safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractClaudePluginInventory } from '../../src/inventory/extract-plugin.js';
import { NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';
import type { ClaudePluginInventory } from '../../src/inventory/types.js';

/**
 * Every directory `readdir` was asked for, in call order — one entry per call, so a
 * directory read twice appears twice. Counts, not a set: the defect this file exists to
 * catch is a *repeat* of a read that already happened, which a set cannot see.
 *
 * `vi.spyOn` is not an option: an ESM module namespace is not configurable, and
 * `extract-plugin.ts` imports `readdir` as a *named* binding, which a spy installed on
 * the default export object would never reach. Replacing the module is the only
 * interception the production call site actually goes through.
 */
const readdirCalls = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>();
	const counted = {
		...actual,
		readdir: (...args: Parameters<typeof actual.readdir>) => {
			const target = args[0];
			readdirCalls.push(typeof target === 'string' ? target : String(target));
			return actual.readdir(...args);
		},
	};
	return { ...counted, default: counted };
});

const SKILL_MD = 'SKILL.md';
const PLUGIN_JSON = 'plugin.json';
const CLAUDE_PLUGIN_DIR = '.claude-plugin';

function skillMd(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} skill, used by the crawl-redundancy fixture.\n---\n\n# ${name}\n`;
}

function writeAt(dir: string, file: string, content: string): void {
	mkdirSyncReal(dir, { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(dir, file), content);
}

/**
 * A plugin whose tree can tell "walked once" apart from "walked twice".
 *
 * The whole-tree crawl behind `unexpected` is not the only thing that reads directories:
 * `commands/` is walked by component discovery and `skills/` is listed by skill
 * discovery, so those two are legitimately read more than once and cannot witness the
 * defect. The directories returned here are reached by the crawl and by *nothing else*,
 * there are seven of them at four different depths, and the tree holds both filenames
 * the crawl looks for — so a per-filename crawl doubles every one of them.
 */
function buildFixture(root: string): string[] {
	const claudePluginDir = safePath.join(root, CLAUDE_PLUGIN_DIR);
	const alpha = safePath.join(root, 'skills', 'alpha');
	const beta = safePath.join(root, 'skills', 'beta');
	const docs = safePath.join(root, 'docs');
	const nested = safePath.join(docs, 'nested');
	const nestedManifestDir = safePath.join(nested, CLAUDE_PLUGIN_DIR);

	writeAt(claudePluginDir, PLUGIN_JSON, JSON.stringify({ name: 'crawl-fixture', version: '1.0.0' }));
	writeAt(alpha, SKILL_MD, skillMd('alpha'));
	writeAt(beta, SKILL_MD, skillMd('beta'));
	writeAt(safePath.join(root, 'commands'), 'foo.md', '# foo\n');
	writeAt(nested, SKILL_MD, skillMd('stray'));
	writeAt(nestedManifestDir, PLUGIN_JSON, JSON.stringify({ name: 'stray-nested' }));

	return [root, claudePluginDir, alpha, beta, docs, nested, nestedManifestDir];
}

/**
 * The tracker-less walk, said out loud.
 *
 * These fixtures have no git repository behind them, so no tracker could
 * answer for them and none of these assertions is about gitignore. Naming the
 * choice is the point: the extractors REQUIRE a source precisely so a suite
 * cannot land in the tracker-less state by leaving an argument off, which is how
 * the walker/closure divergence stayed invisible for three commits.
 */
describe('extractClaudePluginInventory whole-tree crawl', () => {
	const suite = setupAsyncTempDirSuite('extract-plugin-crawl');
	let root = '';
	let crawlOnlyDirs: string[] = [];
	let inventory: ClaudePluginInventory;

	beforeAll(suite.beforeAll);
	afterAll(suite.afterAll);

	beforeEach(async () => {
		await suite.beforeEach();
		root = safePath.join(suite.getTempDir(), 'plugin');
		crawlOnlyDirs = buildFixture(root);
		readdirCalls.length = 0;
		inventory = await extractClaudePluginInventory(root, { gitTrackerSource: NO_GIT_TRACKER });
	});

	it('reads every crawl-only directory exactly once', () => {
		const counts = crawlOnlyDirs.map(dir => ({
			dir: safePath.relative(root, dir) || '.',
			reads: readdirCalls.filter(seen => seen === dir).length,
		}));

		expect(counts).toEqual(crawlOnlyDirs.map(dir => ({
			dir: safePath.relative(root, dir) || '.',
			reads: 1,
		})));
	});

	it('still reports the stray SKILL.md as an unexpected skill manifest', () => {
		expect(inventory.unexpected.skillManifests).toEqual([
			safePath.join(root, 'docs', 'nested', SKILL_MD),
		]);
	});

	it('still reports the stray nested plugin.json as an unexpected plugin manifest', () => {
		expect(inventory.unexpected.pluginManifests).toEqual([
			safePath.join(root, 'docs', 'nested', CLAUDE_PLUGIN_DIR, PLUGIN_JSON),
		]);
	});

	it('discovers both declared skills and the command', () => {
		expect(inventory.discovered.skills.map(s => s.manifest.name)).toEqual(['alpha', 'beta']);
		expect(inventory.discovered.commands).toHaveLength(1);
	});
});
