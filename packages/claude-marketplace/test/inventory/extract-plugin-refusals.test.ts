/**
 * A directory or file the OS REFUSES inside a plugin is recorded in
 * `parseErrors` against its own path — never read as "no skills here", "no
 * commands here", "nothing unexpected here" or "hooks.json is fine".
 *
 * Every case plants a real plugin and refuses exactly one path, so what the
 * extractor meets is one refusal inside an otherwise ordinary tree: an
 * extractor that gave up on the whole plugin would pass a test where
 * everything was refused.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite , refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { extractClaudePluginInventory } from '../../src/inventory/extract-plugin.js';
import { NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';
import type { ClaudePluginInventory } from '../../src/inventory/types.js';

const SKILL_MD = 'SKILL.md';

function writeAt(dir: string, file: string, content: string): void {
	mkdirSyncReal(dir, { recursive: true });
	writeFileSync(safePath.join(dir, file), content);
}

/** A plugin with one skill, one command, a nested stray SKILL.md and a hooks.json. */
function buildPlugin(root: string): void {
	writeAt(safePath.join(root, '.claude-plugin'), 'plugin.json', JSON.stringify({ name: 'refusal-fixture', version: '1.0.0' }));
	writeAt(safePath.join(root, 'skills', 'alpha'), SKILL_MD, '---\nname: alpha\ndescription: the alpha skill, for the refusal fixture.\n---\n\n# alpha\n');
	writeAt(safePath.join(root, 'commands'), 'foo.md', '# foo\n');
	writeAt(safePath.join(root, 'docs', 'nested'), SKILL_MD, '---\nname: stray\ndescription: a stray skill manifest.\n---\n');
	writeAt(safePath.join(root, 'hooks'), 'hooks.json', '{ "hooks": {} }');
}

/** The messages recorded against exactly `path`. */
function recordedAgainst(inv: ClaudePluginInventory, path: string): string[] {
	return inv.parseErrors.filter(e => e.path === path).map(e => e.message);
}

const suite = setupAsyncTempDirSuite('vat-plugin-refusal-');

/**
 * Extract `name` with `fs/promises[method]` refusing `refusedRel` under the
 * plugin root, and return the inventory alongside the refused absolute path.
 */
async function extractWithRefusal(
	name: string,
	method: 'readdir' | 'readFile',
	refusedRel: string[],
): Promise<{ inv: ClaudePluginInventory; refused: string }> {
	const root = safePath.join(suite.getTempDir(), name);
	buildPlugin(root);
	const refused = safePath.join(root, ...refusedRel);
	const restore = refuseAsyncFs(method, refused, 'EACCES');
	try {
		return { inv: await extractClaudePluginInventory(root, { gitTrackerSource: NO_GIT_TRACKER }), refused };
	} finally {
		restore();
	}
}

describe('extractClaudePluginInventory — a refused path is a parse error, not an absence', () => {
	beforeAll(suite.beforeAll);
	afterAll(suite.afterAll);
	beforeEach(suite.beforeEach);

	it('records a skills/ directory it could not list, and does not report a plugin with no skills', async () => {
		const { inv, refused } = await extractWithRefusal('skills-refused', 'readdir', ['skills']);
		expect(inv.discovered.skills).toEqual([]);
		expect(recordedAgainst(inv, refused)).toEqual([expect.stringContaining('EACCES')]);
	});

	it('records a commands/ directory it could not list', async () => {
		const { inv, refused } = await extractWithRefusal('commands-refused', 'readdir', ['commands']);
		expect(inv.discovered.commands).toEqual([]);
		expect(recordedAgainst(inv, refused)).toEqual([expect.stringContaining('EACCES')]);
	});

	it('records a directory the unexpected-files crawl could not list', async () => {
		const { inv, refused } = await extractWithRefusal('crawl-refused', 'readdir', ['docs', 'nested']);
		expect(inv.unexpected.skillManifests).toEqual([]);
		expect(recordedAgainst(inv, refused)).toEqual([expect.stringContaining('EACCES')]);
	});

	it('records a hooks/hooks.json it could not read, rather than passing it as valid JSON', async () => {
		const { inv, refused } = await extractWithRefusal('hooks-refused', 'readFile', ['hooks', 'hooks.json']);
		expect(recordedAgainst(inv, refused)).toEqual([expect.stringMatching(/hooks\/hooks\.json could not be read: .*EACCES/)]);
	});

	it('records nothing when nothing is refused (the positive case beside the four above)', async () => {
		const root = safePath.join(suite.getTempDir(), 'nothing-refused');
		buildPlugin(root);
		const inv = await extractClaudePluginInventory(root, { gitTrackerSource: NO_GIT_TRACKER });
		expect(inv.parseErrors).toEqual([]);
		expect(inv.discovered.skills).toHaveLength(1);
		expect(inv.discovered.commands).toHaveLength(1);
		expect(inv.unexpected.skillManifests).toHaveLength(1);
	});
});
