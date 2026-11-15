/**
 * Unit tests for direct-link resolution deduplication.
 *
 * A skill document may reference the SAME target many times (a routing table that
 * links every row to the same sub-skill, for example). `getResolvedMarkdownLinks`
 * must answer with the DISTINCT set of link targets, and must pay for the existence
 * probe once per distinct target — not once per link occurrence.
 *
 * The probe is `followedKindSync` (its link chain read before the kernel follows it), so
 * that is what is counted: `@vibe-agent-toolkit/utils` is module-mocked, passthrough +
 * counter, because a spy on the ESM namespace cannot see a call through the named binding.
 */

import * as fs from 'node:fs';

import type * as utils from '@vibe-agent-toolkit/utils';
import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getResolvedMarkdownLinks } from '../../src/validators/packaging-validator.js';
import { setupTempDir } from '../test-helpers.js';

const { probeCalls } = vi.hoisted(() => ({ probeCalls: [] as string[] }));

vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
	const actual = await importOriginal<typeof utils>();
	return {
		...actual,
		followedKindSync: (target: string, within: string) => {
			probeCalls.push(target);
			return actual.followedKindSync(target, within);
		},
	};
});

const { getTempDir } = setupTempDir('direct-link-dedup-');

const DUP_TARGET = 'repeated.md';
const OTHER_TARGET = 'other.md';

/**
 * Write the two link targets and return the SKILL.md path they are linked from.
 * The fixture MUST hold two distinct targets, one of them repeated: a fixture with
 * a single link cannot tell "probed once" from "probed five times".
 */
function writeTwoTargets(tempDir: string): string {
	fs.writeFileSync(safePath.join(tempDir, DUP_TARGET), '# Repeated');
	fs.writeFileSync(safePath.join(tempDir, OTHER_TARGET), '# Other');
	return safePath.join(tempDir, 'SKILL.md');
}

/** Five links to the same target plus one to another, in the shape the parser emits. */
function duplicateLinkList(): Array<{ href: string; type: string }> {
	return [
		...Array.from({ length: 5 }, () => ({ href: `./${DUP_TARGET}`, type: 'local_file' })),
		{ href: `./${OTHER_TARGET}`, type: 'local_file' },
	];
}

describe('getResolvedMarkdownLinks - duplicate link targets', () => {
	beforeEach(() => {
		probeCalls.length = 0;
	});

	it('returns each distinct target once, however many times it is linked', () => {
		const tempDir = getTempDir();
		const skillPath = writeTwoTargets(tempDir);

		const resolved = getResolvedMarkdownLinks(duplicateLinkList(), skillPath, tempDir, 'source');

		expect(resolved).toEqual([
			safePath.join(tempDir, DUP_TARGET),
			safePath.join(tempDir, OTHER_TARGET),
		]);
	});

	it('probes the filesystem once per distinct target, not once per link occurrence', () => {
		const tempDir = getTempDir();
		const skillPath = writeTwoTargets(tempDir);

		getResolvedMarkdownLinks(duplicateLinkList(), skillPath, tempDir, 'source');

		expect(probeCalls).toEqual([
			safePath.join(tempDir, DUP_TARGET),
			safePath.join(tempDir, OTHER_TARGET),
		]);
	});

	it('probes a repeatedly-linked MISSING target once, not once per occurrence', () => {
		const tempDir = getTempDir();
		const skillPath = safePath.join(tempDir, 'SKILL.md');
		const missing = Array.from({ length: 4 }, () => ({ href: './gone.md', type: 'local_file' }));

		const resolved = getResolvedMarkdownLinks(missing, skillPath, tempDir, 'source');

		expect(resolved).toEqual([]);
		expect(probeCalls).toEqual([safePath.join(tempDir, 'gone.md')]);
	});
});
