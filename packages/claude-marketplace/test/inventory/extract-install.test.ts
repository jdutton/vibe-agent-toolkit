import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { extractClaudeInstallInventory } from '../../src/inventory/extract-install.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-install');
const FAKE_INSTALL = safePath.join(FIXTURE_BASE, 'fake-install');

describe('extractClaudeInstallInventory', () => {
	describe('fake-install fixture', () => {
		it('returns correct kind and vendor', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.kind).toBe('install');
			expect(inv.vendor).toBe('claude-code');
		});

		it('sets installRoot to the resolved fixture path', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.installRoot).toBe(safePath.resolve(FAKE_INSTALL));
		});

		it('discovers the demo marketplace', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.marketplaces).toHaveLength(1);
			expect(inv.marketplaces[0]?.manifest.name).toBe('demo-marketplace');
		});

		it('discovers the cached plugin', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.plugins).toHaveLength(1);
			expect(inv.plugins[0]?.manifest.name).toBe('demo-plugin');
		});

		it('has no parse errors', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('empty install root', () => {
		it('returns empty inventory with no errors when directories are absent', async () => {
			const inv = await extractClaudeInstallInventory(
				safePath.join(FIXTURE_BASE, 'does-not-exist'),
			);

			expect(inv.kind).toBe('install');
			expect(inv.marketplaces).toEqual([]);
			expect(inv.plugins).toEqual([]);
			expect(inv.parseErrors).toEqual([]);
		});
	});
});
