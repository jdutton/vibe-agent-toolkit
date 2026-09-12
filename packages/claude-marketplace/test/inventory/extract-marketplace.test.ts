import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { detectMarketplacePluginSourceMissing } from '@vibe-agent-toolkit/agent-skills';
import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractClaudeMarketplaceInventory } from '../../src/inventory/extract-marketplace.js';
import { NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-marketplace');
const CLAUDE_PLUGIN_DIR = '.claude-plugin';

/**
 * Build an on-disk marketplace dir with a marketplace.json containing the given content,
 * and return the marketplace root path.
 */
function writeMarketplaceJson(root: string, content: string): string {
	const dir = safePath.join(root, CLAUDE_PLUGIN_DIR);
	mkdirSyncReal(dir, { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(dir, 'marketplace.json'), content);
	return root;
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
describe('extractClaudeMarketplaceInventory', () => {
	describe('local fixture (all four source types)', () => {
		it('returns correct kind and vendor', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.kind).toBe('marketplace');
			expect(inv.vendor).toBe('claude-code');
		});

		it('populates manifest name from marketplace.json', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.manifest.name).toBe('local-test-marketplace');
		});

		it('declares all four plugin entries', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.declared.plugins).toHaveLength(4);
		});

		it('path-source entry that exists has source=path and exists=true', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			const fooRef = inv.declared.plugins.find(p => p.manifestPath === './plugins/foo');
			expect(fooRef).toBeDefined();
			expect(fooRef?.source).toBe('path');
			expect(fooRef?.exists).toBe(true);
		});

		it('path-source entry that is missing has source=path and exists=false', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			const missingRef = inv.declared.plugins.find(p => p.manifestPath === './plugins/missing');
			expect(missingRef).toBeDefined();
			expect(missingRef?.source).toBe('path');
			expect(missingRef?.exists).toBe(false);
		});

		it('github-source entry has source=git', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			const gitRef = inv.declared.plugins.find(p => p.source === 'git');
			expect(gitRef).toBeDefined();
			expect(gitRef?.manifestPath).toBe('github:user/repo');
			expect(gitRef?.exists).toBe(false);
		});

		it('npm-source entry has source=npm', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			const npmRef = inv.declared.plugins.find(p => p.source === 'npm');
			expect(npmRef).toBeDefined();
			expect(npmRef?.manifestPath).toBe('npm:demo-plugin');
			expect(npmRef?.exists).toBe(false);
		});

		it('discovers exactly the one existing path-source plugin', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.discovered.plugins).toHaveLength(1);
		});

		it('discovered plugin has correct manifest name', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			const first = inv.discovered.plugins[0];
			expect(first?.manifest.name).toBe('foo');
		});

		it('has no parse errors', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'), { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('missing marketplace.json edge case', () => {
		it('returns empty inventory with a parse error', async () => {
			const inv = await extractClaudeMarketplaceInventory(
				safePath.join(FIXTURE_BASE, 'does-not-exist'),
				{ gitTrackerSource: NO_GIT_TRACKER },
			);

			expect(inv.kind).toBe('marketplace');
			expect(inv.declared.plugins).toEqual([]);
			expect(inv.discovered.plugins).toEqual([]);
			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
			expect(inv.parseErrors[0]?.message).toContain('marketplace.json not found');
		});
	});

	describe('error and edge cases (synthetic fixtures)', () => {
		let tempDir = '';

		beforeAll(() => {
			tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-test-'));
		});

		afterAll(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it('returns empty inventory with parse error when marketplace.json is malformed JSON', async () => {
			const root = writeMarketplaceJson(safePath.join(tempDir, 'malformed'), '{ not valid json');

			const inv = await extractClaudeMarketplaceInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.declared.plugins).toEqual([]);
			expect(inv.discovered.plugins).toEqual([]);
			expect(inv.parseErrors).toHaveLength(1);
			expect(inv.parseErrors[0]?.path).toContain('marketplace.json');
		});

		it('records schema validation error but still extracts data when manifest violates schema', async () => {
			// Valid JSON but `name` is a number (must be string) — schema fails.
			// We pass `plugins: []` so post-schema iteration succeeds.
			const root = writeMarketplaceJson(
				safePath.join(tempDir, 'schema-fail'),
				JSON.stringify({ name: 123, plugins: [], owner: { name: 'X' } }),
			);

			const inv = await extractClaudeMarketplaceInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
			expect(inv.parseErrors[0]?.message).toContain('schema validation failed');
			// Manifest.name is only set if the raw value is a string, so it's omitted here.
			expect(inv.manifest.name).toBeUndefined();
			expect(inv.declared.plugins).toEqual([]);
		});

		it('treats non-object plugin entries as source=unknown', async () => {
			const root = writeMarketplaceJson(
				safePath.join(tempDir, 'non-object-entry'),
				JSON.stringify({
					name: 'mp',
					owner: { name: 'X' },
					plugins: [42, 'string-not-object', null],
				}),
			);

			const inv = await extractClaudeMarketplaceInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.declared.plugins).toHaveLength(3);
			for (const p of inv.declared.plugins) {
				expect(p.source).toBe('unknown');
				expect(p.exists).toBe(false);
				expect(p.manifestPath).toBe('');
			}
		});

		it('handles object source kinds: url, pip, unknown-default, and non-string/non-object source', async () => {
			const URL_PLUG = 'url-plug';
			const PIP_PLUG = 'pip-plug';
			const MYSTERY_PLUG = 'mystery-plug';
			const NUMERIC = 'numeric';

			const root = writeMarketplaceJson(
				safePath.join(tempDir, 'kinds'),
				JSON.stringify({
					name: 'mp',
					owner: { name: 'X' },
					plugins: [
						{ name: URL_PLUG, source: { source: 'url', url: 'https://example.com/p' } },
						{ name: PIP_PLUG, source: { source: 'pip', package: 'demo-pkg' } },
						{ name: MYSTERY_PLUG, source: { source: 'wat', package: 'mystery-pkg' } },
						{ name: NUMERIC, source: 42 },
					],
				}),
			);

			const inv = await extractClaudeMarketplaceInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

			const order = [URL_PLUG, PIP_PLUG, MYSTERY_PLUG, NUMERIC];
			const byName = new Map(inv.declared.plugins.map((p, i) => [order[i] ?? '', p]));

			const urlRef = byName.get(URL_PLUG);
			expect(urlRef?.source).toBe('git');
			expect(urlRef?.manifestPath).toBe('https://example.com/p');

			const pipRef = byName.get(PIP_PLUG);
			expect(pipRef?.source).toBe('unknown');
			expect(pipRef?.manifestPath).toBe('pip:demo-pkg');

			const unknownRef = byName.get(MYSTERY_PLUG);
			expect(unknownRef?.source).toBe('unknown');
			expect(unknownRef?.manifestPath).toBe('wat:mystery-pkg');

			const numericRef = byName.get(NUMERIC);
			expect(numericRef?.source).toBe('unknown');
			expect(numericRef?.manifestPath).toBe('');
		});
	});
});

/**
 * A plugin directory with enough inside it that a walk leaves a trace: a
 * plugin manifest and one skill. Placed OUTSIDE a marketplace root, every
 * containment case asserts that none of its paths surface in the inventory;
 * placed inside, it is the positive control.
 */
function writePluginDir(dir: string, name: string): string {
	mkdirSyncReal(safePath.join(dir, CLAUDE_PLUGIN_DIR), { recursive: true });
	mkdirSyncReal(safePath.join(dir, 'skills', 'x'), { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(dir, CLAUDE_PLUGIN_DIR, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(dir, 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: fixture\n---\n# x\n');
	return dir;
}

function marketplaceDeclaring(root: string, entries: Array<{ name: string; source: string }>): string {
	return writeMarketplaceJson(root, JSON.stringify({ name: 'mp', owner: { name: 'X' }, plugins: entries }));
}

type Inventory = Awaited<ReturnType<typeof extractClaudeMarketplaceInventory>>;

/** Every absolute path the inventory publishes, from both ledgers, one level deep. */
function everyPublishedPath(inv: Inventory): string[] {
	return [
		...inv.declared.plugins.map(p => p.resolvedPath),
		...inv.discovered.plugins.flatMap(p => [
			p.path,
			...p.discovered.skills.map(s => s.path),
			...p.parseErrors.map(e => e.path),
		]),
	];
}

/**
 * The containment contract, asserted the same way for every refused spelling:
 * the outside directory is never walked, nothing published resolves outside
 * the root, the refusal names the source, and the SOURCE_MISSING detector that
 * `vat audit` runs over this inventory names it too and lands INSIDE the root —
 * never at `../`.
 */
async function expectRefusedWithoutLeaving(root: string, outside: string, source: string): Promise<void> {
	const inv = await extractClaudeMarketplaceInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

	expect(inv.discovered.plugins).toEqual([]);
	for (const p of everyPublishedPath(inv)) {
		expect(p.startsWith(outside)).toBe(false);
		expect(safePath.relative(root, p).startsWith('..')).toBe(false);
	}
	const ref = inv.declared.plugins.find(p => p.manifestPath === source);
	expect(ref?.source).toBe('path');
	expect(ref?.exists).toBe(false);
	expect(inv.parseErrors.some(e => e.message.includes(source) && e.message.includes('outside'))).toBe(true);

	const findings = detectMarketplacePluginSourceMissing(inv, root);
	expect(findings.map(f => f.message).join('\n')).toContain(source);
	expect(findings.length).toBeGreaterThan(0);
	for (const f of findings) {
		expect(f.location).toBe(`${CLAUDE_PLUGIN_DIR}/marketplace.json`);
	}
}

async function expectWalked(root: string, pluginName: string): Promise<void> {
	const inv = await extractClaudeMarketplaceInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

	expect(inv.parseErrors).toEqual([]);
	expect(inv.discovered.plugins.map(p => p.manifest.name)).toEqual([pluginName]);
	expect(inv.declared.plugins[0]?.exists).toBe(true);
	expect(detectMarketplacePluginSourceMissing(inv, root)).toEqual([]);
}

describe('a declared source never leaves the marketplace root', () => {
	let tempDir = '';
	let outside = '';

	beforeAll(() => {
		tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-contain-'));
		outside = writePluginDir(safePath.join(tempDir, 'outside-target'), 'outside');
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('walks a contained relative source (control)', async () => {
		const root = safePath.join(tempDir, 'ok');
		writePluginDir(safePath.join(root, 'plugins', 'a'), 'inside-a');
		marketplaceDeclaring(root, [{ name: 'a', source: './plugins/a' }]);

		await expectWalked(root, 'inside-a');
	});

	it('refuses an ABSOLUTE source and never walks it', async () => {
		const root = marketplaceDeclaring(safePath.join(tempDir, 'abs'), [{ name: 'out', source: outside }]);

		await expectRefusedWithoutLeaving(root, outside, outside);
	});

	it('refuses a forward-slash parent traversal (../x)', async () => {
		const root = marketplaceDeclaring(safePath.join(tempDir, 'fwd'), [{ name: 'out', source: '../outside-target' }]);

		await expectRefusedWithoutLeaving(root, outside, '../outside-target');
	});

	it(String.raw`refuses a backslash traversal inside the path (plugins\..\..\x)`, async () => {
		const source = String.raw`plugins\..\..\outside-target`;
		const root = marketplaceDeclaring(safePath.join(tempDir, 'bsl'), [{ name: 'out', source }]);

		await expectRefusedWithoutLeaving(root, outside, source);
	});

	it(String.raw`refuses a leading backslash traversal (..\x)`, async () => {
		const source = String.raw`..\outside-target`;
		const root = marketplaceDeclaring(safePath.join(tempDir, 'bsl2'), [{ name: 'out', source }]);

		await expectRefusedWithoutLeaving(root, outside, source);
	});

	it('refuses a symlink inside the root that points outside it', async ({ skip }) => {
		const cap = symlinkCapability();
		if (cap === null) {
			skip('this process cannot create symlinks');
			return;
		}
		const root = marketplaceDeclaring(safePath.join(tempDir, 'sym'), [{ name: 's', source: './plugins/s' }]);
		mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
		createSymlink(cap, outside, safePath.join(root, 'plugins', 's'), 'dir');

		await expectRefusedWithoutLeaving(root, outside, './plugins/s');
	});

	it('walks a symlink inside the root that points inside it (control for the realpath lane)', async ({ skip }) => {
		const cap = symlinkCapability();
		if (cap === null) {
			skip('this process cannot create symlinks');
			return;
		}
		const root = safePath.join(tempDir, 'sym-in');
		writePluginDir(safePath.join(root, 'real-a'), 'linked-a');
		marketplaceDeclaring(root, [{ name: 'a', source: './plugins/a' }]);
		mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
		createSymlink(cap, safePath.join(root, 'real-a'), safePath.join(root, 'plugins', 'a'), 'dir');

		await expectWalked(root, 'linked-a');
	});
});
