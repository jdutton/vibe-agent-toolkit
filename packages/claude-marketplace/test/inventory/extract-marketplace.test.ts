import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractClaudeMarketplaceInventory } from '../../src/inventory/extract-marketplace.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-marketplace');

/**
 * Build an on-disk marketplace dir with a marketplace.json containing the given content,
 * and return the marketplace root path.
 */
function writeMarketplaceJson(root: string, content: string): string {
	const dir = safePath.join(root, '.claude-plugin');
	mkdirSyncReal(dir, { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(dir, 'marketplace.json'), content);
	return root;
}

describe('extractClaudeMarketplaceInventory', () => {
	describe('local fixture (all four source types)', () => {
		it('returns correct kind and vendor', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			expect(inv.kind).toBe('marketplace');
			expect(inv.vendor).toBe('claude-code');
		});

		it('populates manifest name from marketplace.json', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			expect(inv.manifest.name).toBe('local-test-marketplace');
		});

		it('declares all four plugin entries', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			expect(inv.declared.plugins).toHaveLength(4);
		});

		it('path-source entry that exists has source=path and exists=true', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			const fooRef = inv.declared.plugins.find(p => p.manifestPath === './plugins/foo');
			expect(fooRef).toBeDefined();
			expect(fooRef?.source).toBe('path');
			expect(fooRef?.exists).toBe(true);
		});

		it('path-source entry that is missing has source=path and exists=false', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			const missingRef = inv.declared.plugins.find(p => p.manifestPath === './plugins/missing');
			expect(missingRef).toBeDefined();
			expect(missingRef?.source).toBe('path');
			expect(missingRef?.exists).toBe(false);
		});

		it('github-source entry has source=git', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			const gitRef = inv.declared.plugins.find(p => p.source === 'git');
			expect(gitRef).toBeDefined();
			expect(gitRef?.manifestPath).toBe('github:user/repo');
			expect(gitRef?.exists).toBe(false);
		});

		it('npm-source entry has source=npm', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			const npmRef = inv.declared.plugins.find(p => p.source === 'npm');
			expect(npmRef).toBeDefined();
			expect(npmRef?.manifestPath).toBe('npm:demo-plugin');
			expect(npmRef?.exists).toBe(false);
		});

		it('discovers exactly the one existing path-source plugin', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			expect(inv.discovered.plugins).toHaveLength(1);
		});

		it('discovered plugin has correct manifest name', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			const first = inv.discovered.plugins[0];
			expect(first?.manifest.name).toBe('foo');
		});

		it('has no parse errors', async () => {
			const inv = await extractClaudeMarketplaceInventory(safePath.join(FIXTURE_BASE, 'local'));

			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('missing marketplace.json edge case', () => {
		it('returns empty inventory with a parse error', async () => {
			const inv = await extractClaudeMarketplaceInventory(
				safePath.join(FIXTURE_BASE, 'does-not-exist'),
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

			const inv = await extractClaudeMarketplaceInventory(root);

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

			const inv = await extractClaudeMarketplaceInventory(root);

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

			const inv = await extractClaudeMarketplaceInventory(root);

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

			const inv = await extractClaudeMarketplaceInventory(root);

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
