import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { extractClaudeMarketplaceInventory } from '../../src/inventory/extract-marketplace.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-marketplace');

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
});
