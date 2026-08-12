/**
 * Unit tests for direct-link resolution deduplication.
 *
 * A skill document may reference the SAME target many times (a routing table that
 * links every row to the same sub-skill, for example). `getResolvedMarkdownLinks`
 * must answer with the DISTINCT set of link targets, and must pay for the existence
 * probe once per distinct target — not once per link occurrence.
 *
 * `node:fs` is mocked (module mock, passthrough + counter) rather than spied on the
 * ESM namespace: `vi.spyOn` throws on a namespace object and silently under-counts on
 * the default export, so it cannot answer "how many probes".
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import type * as NodeFs from 'node:fs';
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getResolvedMarkdownLinks } from '../../src/validators/packaging-validator.js';
import { setupTempDir } from '../test-helpers.js';

const { existsSyncCalls } = vi.hoisted(() => ({ existsSyncCalls: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		default: actual,
		existsSync: (p: Parameters<NodeFs['existsSync']>[0]) => {
			existsSyncCalls.push(String(p));
			return actual.existsSync(p);
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
		existsSyncCalls.length = 0;
	});

	it('returns each distinct target once, however many times it is linked', () => {
		const tempDir = getTempDir();
		const skillPath = writeTwoTargets(tempDir);

		const resolved = getResolvedMarkdownLinks(duplicateLinkList(), skillPath);

		expect(resolved).toEqual([
			safePath.join(tempDir, DUP_TARGET),
			safePath.join(tempDir, OTHER_TARGET),
		]);
	});

	it('probes the filesystem once per distinct target, not once per link occurrence', () => {
		const tempDir = getTempDir();
		const skillPath = writeTwoTargets(tempDir);

		getResolvedMarkdownLinks(duplicateLinkList(), skillPath);

		expect(existsSyncCalls).toEqual([
			safePath.join(tempDir, DUP_TARGET),
			safePath.join(tempDir, OTHER_TARGET),
		]);
	});

	it('probes a repeatedly-linked MISSING target once, not once per occurrence', () => {
		const tempDir = getTempDir();
		const skillPath = safePath.join(tempDir, 'SKILL.md');
		const missing = Array.from({ length: 4 }, () => ({ href: './gone.md', type: 'local_file' }));

		const resolved = getResolvedMarkdownLinks(missing, skillPath);

		expect(resolved).toEqual([]);
		expect(existsSyncCalls).toEqual([safePath.join(tempDir, 'gone.md')]);
	});
});
