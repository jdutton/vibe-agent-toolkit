/**
 * A plugin path that is a link to `\\host\share` is never handed to the kernel (a Windows kernel
 * resolving it offers the operator's NTLM credentials to the host) — and it is never read as
 * "not there" either: the plugin extractor records it as a refusal (`unreadable`), and the compat
 * lanes' walk records it in `unlistable`.
 *
 * The host flavor the guard binds is set to `win32` (the shared `utils` build's `link-chain`
 * module, mocked), so this runs Windows semantics on every host over a real tree whose link's text
 * is a UNC path — on POSIX a legal file name no kernel would send anywhere, which a plain followed
 * probe answers "absent" for.
 */

import { writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractClaudePluginInventory } from '../../src/inventory/extract-plugin.js';
import { NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';
import { walkFollowingLinks } from '../../src/walk-following-links.js';

vi.mock('../../../utils/dist/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const CAPABILITY = symlinkCapability();
const UNC = String.raw`\\attacker\share\hooks`;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir);
});

/** A plugin with a manifest and one command, whose `hooks` directory is a link to a UNC path. */
function plugin(): string {
	if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
	const root = createTempDir('vat-plugin-link-chain-');
	dirs.push(root);
	mkdirSyncReal(safePath.join(root, '.claude-plugin'));
	writeFileSync(safePath.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p' }));
	mkdirSyncReal(safePath.join(root, 'commands'));
	writeFileSync(safePath.join(root, 'commands', 'go.md'), '# go\n');
	createSymlink(CAPABILITY, UNC, safePath.join(root, 'hooks'), 'dir');
	return root;
}

describe.skipIf(CAPABILITY === null)('a plugin link to a network path (win32 semantics)', () => {
	it('is recorded by the plugin extractor as a refusal against the link, never read as absent', async () => {
		const root = plugin();

		const inventory = await extractClaudePluginInventory(root, { gitTrackerSource: NO_GIT_TRACKER });

		const hooksJson = safePath.join(root, 'hooks', 'hooks.json');
		expect(inventory.parseErrors).toContainEqual(expect.objectContaining({ path: hooksJson, unreadable: true, message: expect.stringContaining('Refusing to resolve') }));
		// Positive control: the rest of the plugin is read.
		expect(inventory.discovered.commands.map((ref) => ref.manifestPath)).toHaveLength(1);
	});

	it('is recorded by the compat lanes\' walk as unlistable, never silently skipped', async () => {
		const root = plugin();

		const walked = await walkFollowingLinks(root);

		expect(walked.unlistable).toContainEqual(expect.objectContaining({ path: safePath.join(root, 'hooks'), reason: expect.stringContaining('Refusing to resolve') }));
		expect(walked.files).toContain(safePath.join(root, 'commands', 'go.md'));
	});
});
