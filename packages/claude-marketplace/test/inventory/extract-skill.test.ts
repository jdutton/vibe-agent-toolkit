import { dirname } from 'node:path';

import type { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, GitTracker, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	crawlSkillLinkRegistry,
	extractClaudeSkillInventory,
	type GitTrackerSource,
} from '../../src/inventory/extract-skill.js';

const FIXTURE_DIR = safePath.resolve(__dirname, '../fixtures/inventory-skill');
const SKILL_MD = safePath.resolve(FIXTURE_DIR, 'SKILL.md');

/** One extraction against a pre-crawled registry, reduced to what the assertions read. */
async function extractWith(
	registry: ResourceRegistry,
	source: GitTrackerSource,
): Promise<{ linked: string[]; parseErrors: Array<{ path: string; message: string }> }> {
	const inv = await extractClaudeSkillInventory(SKILL_MD, registry, source);
	return { linked: inv.files.linked, parseErrors: [...inv.parseErrors] };
}

describe('extractClaudeSkillInventory', () => {
	it('returns a ClaudeSkillInventory with correct manifest, paths, and linked files', async () => {
		const inv = await extractClaudeSkillInventory(SKILL_MD);

		expect(inv.kind).toBe('skill');
		expect(inv.vendor).toBe('claude-code');
		expect(inv.manifest.name).toBe('example-skill');
		expect(inv.manifest.description).toBe('Test skill for inventory extraction');
		expect(inv.files.skillMd.endsWith('SKILL.md')).toBe(true);
		expect(inv.files.linked.length).toBeGreaterThanOrEqual(1);
		expect(inv.files.linked.some(p => p.endsWith('reference.md'))).toBe(true);
		expect(inv.files.packaged).toEqual([]);
		expect(inv.parseErrors).toEqual([]);
	});

	it('returns a ClaudeSkillInventory with parseErrors when SKILL.md does not exist', async () => {
		const nonExistent = safePath.resolve(FIXTURE_DIR, 'does-not-exist/SKILL.md');
		const inv = await extractClaudeSkillInventory(nonExistent);

		expect(inv.kind).toBe('skill');
		expect(inv.vendor).toBe('claude-code');
		expect(inv.manifest.name).toBe('');
		expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
	});
});

/**
 * The optional third argument: a way to obtain the GitTracker for whatever
 * project root the walk lands on.
 *
 * The registry is crawled once and shared by every case below — not an
 * optimization detail but the only way these stay unit-speed, since each
 * extraction otherwise re-crawls the whole surrounding corpus. Its base dir is
 * the same root `walkLinkedFiles` computes, which is what makes it eligible for
 * reuse (see `registryFor`).
 */
describe('extractClaudeSkillInventory git-tracker source', () => {
	const projectRoot = findProjectRoot(dirname(SKILL_MD)) ?? dirname(SKILL_MD);
	let registry: ResourceRegistry;
	let baseline: string[];

	beforeAll(async () => {
		registry = await crawlSkillLinkRegistry(projectRoot);
		baseline = (await extractClaudeSkillInventory(SKILL_MD, registry)).files.linked;
	});

	it('asks about the walk project root and routes gitignore questions through the tracker', async () => {
		const rootsAsked: string[] = [];
		let activeSetLookups = 0;

		const { linked, parseErrors } = await extractWith(registry, async root => {
			rootsAsked.push(root);
			const tracker = new GitTracker(root);
			await tracker.initialize();
			const answer = tracker.isIgnoredByActiveSet.bind(tracker);
			tracker.isIgnoredByActiveSet = (p: string): boolean => {
				activeSetLookups += 1;
				return answer(p);
			};
			return tracker;
		});

		expect(rootsAsked).toEqual([projectRoot]);
		// The tracker is not merely accepted — the walk actually consults it, which
		// is the whole point: each of these replaces a `git check-ignore` spawn.
		expect(activeSetLookups).toBeGreaterThan(0);
		expect(linked).toEqual(baseline);
		expect(parseErrors).toEqual([]);
	});

	it('degrades to the untracked walk when the source throws, without inventing a parse error', async () => {
		const { linked, parseErrors } = await extractWith(registry, () => {
			throw new Error('git ls-files unavailable');
		});

		expect(linked).toEqual(baseline);
		expect(parseErrors).toEqual([]);
	});

	it('degrades to the untracked walk when the source declines to answer for a root', async () => {
		const { linked, parseErrors } = await extractWith(registry, async () => undefined);

		expect(linked).toEqual(baseline);
		expect(parseErrors).toEqual([]);
	});
});
