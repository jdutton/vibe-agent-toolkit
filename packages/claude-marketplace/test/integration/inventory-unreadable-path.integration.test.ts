/**
 * A manifest or plugin path the OS will not let the extractor examine is a
 * recorded refusal (`unreadable: true`), never "not found": `existsSync`
 * answered `false` for an `EACCES` parent, and the inventory then read as a
 * marketplace with no manifest, a plugin with no plugin.json, or a plugin path
 * that does not exist.
 *
 * Real permissions, not an injected errno: the probe is a sync `stat`, and what
 * is under test is that a real refusal reaches the classifier.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import type { InventoryParseError } from '@vibe-agent-toolkit/agent-skills';
import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, registerScratchTmpdir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractClaudeMarketplaceInventory } from '../../src/inventory/extract-marketplace.js';
import { extractClaudePluginInventory } from '../../src/inventory/extract-plugin.js';
import { NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';

// Every tree below lives in a per-test scratch that is also TMPDIR/TEMP/TMP.
const scratch = registerScratchTmpdir('inventory-unreadable-', { beforeEach, afterEach });
const OPTIONS = { gitTrackerSource: NO_GIT_TRACKER } as const;

/** Write `file` under `dir`, making `dir`. */
function writeAt(dir: string, file: string, content: string): string {
	mkdirSyncReal(dir, { recursive: true });
	const path = safePath.join(dir, file);
	writeFileSync(path, content);
	return path;
}

/** Run `extract` with `dir` unsearchable, restoring it before scratch teardown. */
async function withLocked<T>(dir: string, extract: () => Promise<T>): Promise<T> {
	chmodSync(dir, 0o000);
	try {
		return await extract();
	} finally {
		chmodSync(dir, 0o700);
	}
}

/** The rows recorded against exactly `path`. */
function rowsAt(parseErrors: readonly InventoryParseError[], path: string): InventoryParseError[] {
	return parseErrors.filter((row) => row.path === path);
}

// chmod 000 does not restrict access on Windows, and root bypasses permission checks:
// either makes every case below assert nothing.
describe.skipIf(CANNOT_DENY_READS)('inventory extractors — an unsearchable parent is a refusal, not an absence', () => {
	it('records a marketplace.json it may not examine as unreadable, not "not found"', async () => {
		const root = safePath.join(scratch(), 'mp');
		const manifestDir = safePath.join(root, '.claude-plugin');
		const manifest = writeAt(manifestDir, 'marketplace.json', JSON.stringify({ name: 'mp', owner: { name: 'o' }, plugins: [] }));
		const inv = await withLocked(manifestDir, () => extractClaudeMarketplaceInventory(root, OPTIONS));
		expect(rowsAt(inv.parseErrors, manifest)).toEqual([expect.objectContaining({ unreadable: true, message: expect.stringContaining('EACCES') })]);
	});

	it('records a plugin.json it may not examine as unreadable, never a plugin with no manifest', async () => {
		const root = safePath.join(scratch(), 'plugin');
		const manifestDir = safePath.join(root, '.claude-plugin');
		const manifest = writeAt(manifestDir, 'plugin.json', JSON.stringify({ name: 'plugin', version: '1.0.0' }));
		const inv = await withLocked(manifestDir, () => extractClaudePluginInventory(root, OPTIONS));
		expect(rowsAt(inv.parseErrors, manifest)).toEqual([expect.objectContaining({ unreadable: true, message: expect.stringContaining('EACCES') })]);
	});

	it('records a plugin path it may not examine as unreadable, not "does not exist"', async () => {
		const locked = safePath.join(scratch(), 'locked');
		const root = safePath.join(locked, 'plugin');
		writeAt(safePath.join(root, '.claude-plugin'), 'plugin.json', JSON.stringify({ name: 'plugin', version: '1.0.0' }));
		const inv = await withLocked(locked, () => extractClaudePluginInventory(root, OPTIONS));
		expect(rowsAt(inv.parseErrors, root)).toEqual([expect.objectContaining({ unreadable: true, message: expect.stringContaining('EACCES') })]);
	});

	// Every probe inside a plugin root the process may not search: each is its own refusal, none an absence.
	it('records every probe under an unsearchable plugin root as unreadable', async () => {
		const root = safePath.join(scratch(), 'plugin');
		writeAt(safePath.join(root, '.claude-plugin'), 'plugin.json', JSON.stringify({ name: 'plugin', version: '1.0.0' }));
		writeAt(safePath.join(root, 'skills', 'one'), 'SKILL.md', '---\nname: one\ndescription: d\n---\n');
		const inv = await withLocked(root, () => extractClaudePluginInventory(root, OPTIONS));
		const under = (...segments: string[]): string => safePath.join(root, ...segments);
		expect(inv.parseErrors.map((row) => row.unreadable)).toEqual(inv.parseErrors.map(() => true));
		expect(inv.parseErrors.map((row) => row.path)).toEqual([
			under('.claude-plugin', 'plugin.json'),
			under('SKILL.md'),
			under('skills'),
			under('commands'),
			under('agents'),
			root,
			under('hooks', 'hooks.json'),
			under('.mcp.json'),
		]);
	});

	// A declared `skills` path is probed as a manifest ref and again by discovery: one refusal, one row.
	it('records a declared skills directory it may not examine once, not once per lane', async ({ skip }) => {
		const cap = symlinkCapability() ?? skip('this process cannot create symlinks');
		const root = safePath.join(scratch(), 'plugin');
		const locked = safePath.join(scratch(), 'locked');
		writeAt(safePath.join(root, '.claude-plugin'), 'plugin.json', JSON.stringify({ name: 'plugin', version: '1.0.0', skills: './skills' }));
		writeAt(safePath.join(locked, 'skills', 'one'), 'SKILL.md', '---\nname: one\ndescription: d\n---\n');
		const skills = safePath.join(root, 'skills');
		createSymlink(cap, safePath.join(locked, 'skills'), skills, 'dir');
		const inv = await withLocked(locked, () => extractClaudePluginInventory(root, OPTIONS));
		expect(inv.declared.skills).toEqual([{ manifestPath: './skills', resolvedPath: skills, exists: false }]);
		expect(rowsAt(inv.parseErrors, skills)).toEqual([expect.objectContaining({ unreadable: true, message: expect.stringContaining('EACCES') })]);
	});

	// The positive control on the same shapes: an absence is still an absence.
	it('still reports a missing marketplace.json as not found, and a missing plugin path as absent', async () => {
		const mpRoot = safePath.join(scratch(), 'empty-mp');
		mkdirSyncReal(mpRoot, { recursive: true });
		const mp = await extractClaudeMarketplaceInventory(mpRoot, OPTIONS);
		expect(mp.parseErrors).toEqual([{ path: safePath.join(mpRoot, '.claude-plugin', 'marketplace.json'), message: 'marketplace.json not found' }]);
		const missing = safePath.join(scratch(), 'no-plugin');
		const plugin = await extractClaudePluginInventory(missing, OPTIONS);
		expect(plugin.parseErrors).toEqual([{ path: missing, message: `plugin path does not exist: ${missing}` }]);
	});
});
