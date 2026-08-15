import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { type ResourceRegistry } from '@vibe-agent-toolkit/resources';
import {
	__readCrawlTimingSnapshot,
	__setCrawlTimingForTest,
	CRAWL_PASS_INSIDE,
	CRAWL_REGISTRY_ADD_RESOURCE_ID,
	CRAWL_REGISTRY_ENUMERATE_ID,
	findProjectRoot,
	GitTracker,
	mkdirSyncReal,
	safeExecSync,
	safePath,
	setupAsyncTempDirSuite,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	crawlSkillLinkRegistry,
	extractClaudeSkillInventory,
	NO_GIT_TRACKER,
	type GitTrackerSource,
} from '../../src/inventory/extract-skill.js';

const SKILL_FILENAME = 'SKILL.md';
const REFERENCE_FILENAME = 'reference.md';
const LATE_NOTE_FILENAME = 'late-note.md';
const IGNORED_NOTE_FILENAME = 'ignored-note.md';

const FIXTURE_DIR = safePath.resolve(__dirname, '../fixtures/inventory-skill');
const SKILL_MD = safePath.resolve(FIXTURE_DIR, SKILL_FILENAME);

/** The SKILL.md of the divergence fixture: one committed link, one late link, one ignored link. */
const DIVERGENT_SKILL_MD = [
	'---',
	'name: divergent-skill',
	'description: Fixture whose linked set depends on which gitignore oracle answers',
	'---',
	'',
	'# Divergent Skill',
	'',
	`[Reference](./${REFERENCE_FILENAME})`,
	`[Late note](./${LATE_NOTE_FILENAME})`,
	`[Ignored note](./${IGNORED_NOTE_FILENAME})`,
	'',
].join('\n');

/** Write one file into the temp fixture repository, creating its directory. */
function writeRepoFile(root: string, relative: string, contents: string): void {
	mkdirSyncReal(root, { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- a path composed under this suite's own temp root
	writeFileSync(safePath.join(root, relative), contents, 'utf-8');
}

/**
 * `git init` + `add` + `commit` the fixture repository.
 *
 * Not ceremony: `crawlSkillLinkRegistry` reaches its file set through
 * `git ls-files`, and `.gitignore` needs a repository to mean anything at all
 * ([[tmpdir-fixture-has-no-gitignore]]). The commit is what makes the tracker's
 * snapshot a real one rather than a listing of loose files.
 */
function commitRepo(root: string): void {
	const identity = ['-c', 'user.email=t@example.com', '-c', 'user.name=t'];
	const steps = [['init', '-q'], ['add', '-A'], [...identity, 'commit', '-qm', 'fixture']];
	for (const args of steps) {
		safeExecSync('git', args, { cwd: root });
	}
}

/** One extraction against a pre-crawled registry, reduced to what the assertions read. */
async function extractWith(
	skillMdPath: string,
	registry: ResourceRegistry,
	source: GitTrackerSource,
): Promise<{ linked: string[]; parseErrors: Array<{ path: string; message: string }> }> {
	const inv = await extractClaudeSkillInventory(skillMdPath, {
		sharedRegistry: registry,
		gitTrackerSource: source,
	});
	return { linked: inv.files.linked, parseErrors: [...inv.parseErrors] };
}

describe('extractClaudeSkillInventory', () => {
	it('returns a ClaudeSkillInventory with correct manifest, paths, and linked files', async () => {
		// `NO_GIT_TRACKER`, not an omitted argument: these two cases are about
		// frontmatter and parseErrors, and the tracker-less walk they run in is a
		// choice they are making, not a default they fell into.
		const inv = await extractClaudeSkillInventory(SKILL_MD, { gitTrackerSource: NO_GIT_TRACKER });

		expect(inv.kind).toBe('skill');
		expect(inv.vendor).toBe('claude-code');
		expect(inv.manifest.name).toBe('example-skill');
		expect(inv.manifest.description).toBe('Test skill for inventory extraction');
		expect(inv.files.skillMd.endsWith(SKILL_FILENAME)).toBe(true);
		expect(inv.files.linked.length).toBeGreaterThanOrEqual(1);
		expect(inv.files.linked.some(p => p.endsWith(REFERENCE_FILENAME))).toBe(true);
		expect(inv.files.packaged).toEqual([]);
		expect(inv.parseErrors).toEqual([]);
	});

	it('returns a ClaudeSkillInventory with parseErrors when SKILL.md does not exist', async () => {
		const nonExistent = safePath.resolve(FIXTURE_DIR, 'does-not-exist/SKILL.md');
		const inv = await extractClaudeSkillInventory(nonExistent, { gitTrackerSource: NO_GIT_TRACKER });

		expect(inv.kind).toBe('skill');
		expect(inv.vendor).toBe('claude-code');
		expect(inv.manifest.name).toBe('');
		expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
	});
});

/**
 * The required `gitTrackerSource` option: a way to obtain the GitTracker for
 * whatever project root the walk lands on.
 *
 * ⚠️ Every case here compares against `baseline`, which is taken with
 * `NO_GIT_TRACKER` — so on this fixture they assert only that the tracker
 * changes NOTHING. That is a real property (a tracker must not alter the
 * answer, only the cost) but it is blind by construction to a lane that lost
 * its tracker. The divergence suite at the bottom of this file is what makes
 * the two states distinguishable at all; do not add a case here and believe it
 * covers that.
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
		baseline = (await extractWith(SKILL_MD, registry, NO_GIT_TRACKER)).linked;
	});

	it('asks about the walk project root and routes gitignore questions through the tracker', async () => {
		const rootsAsked: string[] = [];
		let activeSetLookups = 0;

		const { linked, parseErrors } = await extractWith(SKILL_MD, registry, async root => {
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
		const { linked, parseErrors } = await extractWith(SKILL_MD, registry, () => {
			throw new Error('git ls-files unavailable');
		});

		expect(linked).toEqual(baseline);
		expect(parseErrors).toEqual([]);
	});

	it('degrades to the untracked walk when the source declines to answer for a root', async () => {
		const { linked, parseErrors } = await extractWith(SKILL_MD, registry, async () => undefined);

		expect(linked).toEqual(baseline);
		expect(parseErrors).toEqual([]);
	});
});

/**
 * A fixture that can tell the two tracker states APART.
 *
 * Every case above compares against a `baseline` taken with no tracker, so all of
 * them would still pass on a corpus where the tracker changes nothing — and the
 * committed `inventory-skill/` fixture is exactly such a corpus (measured: both
 * arms return the same single `reference.md`). A suite made only of those cases
 * cannot notice that a lane lost its tracker, which is how the library-surface
 * hole this fixture exists for stayed invisible.
 *
 * The divergence is the staleness bound documented on `GitTrackerSource`: a
 * tracker snapshots `git ls-files` at `initialize()`, so a file that appears on
 * disk AFTER that snapshot is absent from the active set and
 * `isIgnoredByActiveSet` calls it **ignored**. The no-tracker oracle asks
 * `git check-ignore`, which answers from the ignore PATTERNS and calls the same
 * file not ignored. Same link, same walk, two different `files.linked`.
 *
 * `ignored-note.md` is the negative control: a target both oracles agree is
 * ignored. Without it, "the tracker arm dropped a file" would be equally
 * explained by a tracker that drops everything.
 */
describe('extractClaudeSkillInventory tracker-state divergence', () => {
	const suite = setupAsyncTempDirSuite('extract-skill-tracker');
	let repoRoot = '';
	let repoSkillMd = '';
	let referenceMd = '';
	let lateNoteMd = '';
	let ignoredNoteMd = '';
	let staleTracker: GitTracker;
	let repoRegistry: ResourceRegistry;

	beforeAll(async () => {
		await suite.beforeAll();
		await suite.beforeEach();
		repoRoot = safePath.join(suite.getTempDir(), 'repo');
		repoSkillMd = safePath.join(repoRoot, SKILL_FILENAME);
		referenceMd = safePath.join(repoRoot, REFERENCE_FILENAME);
		lateNoteMd = safePath.join(repoRoot, LATE_NOTE_FILENAME);
		ignoredNoteMd = safePath.join(repoRoot, IGNORED_NOTE_FILENAME);

		writeRepoFile(repoRoot, '.gitignore', `${IGNORED_NOTE_FILENAME}\n`);
		writeRepoFile(repoRoot, SKILL_FILENAME, DIVERGENT_SKILL_MD);
		writeRepoFile(repoRoot, REFERENCE_FILENAME, '# reference\n');
		writeRepoFile(repoRoot, IGNORED_NOTE_FILENAME, '# ignored\n');
		commitRepo(repoRoot);

		// The snapshot is taken HERE — before `late-note.md` exists. Everything the
		// tracker will ever say about this repository is fixed at this line.
		staleTracker = new GitTracker(repoRoot);
		await staleTracker.initialize();

		writeRepoFile(repoRoot, LATE_NOTE_FILENAME, '# late\n');
		repoRegistry = await crawlSkillLinkRegistry(repoRoot);
	});

	afterAll(suite.afterAll);

	it('roots the walk at the fixture repository', () => {
		// Without this the two arms below could be walking some ancestor of the temp
		// dir, and their agreement or disagreement would be about the wrong tree.
		expect(findProjectRoot(dirname(repoSkillMd))).toBe(repoRoot);
	});

	it('keeps the post-snapshot link target when no tracker answers', async () => {
		const { linked } = await extractWith(repoSkillMd, repoRegistry, NO_GIT_TRACKER);

		// Exact and ordered — link order in SKILL.md. A set comparison here would let a
		// later change reorder the walk without anyone noticing which file it dropped.
		expect(linked).toEqual([referenceMd, lateNoteMd]);
	});

	it('drops the post-snapshot link target when a tracker answers', async () => {
		const { linked } = await extractWith(repoSkillMd, repoRegistry, async () => staleTracker);

		expect(linked).toEqual([referenceMd]);
	});

	it('excludes the genuinely gitignored target in both states', async () => {
		const withTracker = await extractWith(repoSkillMd, repoRegistry, async () => staleTracker);
		const withoutTracker = await extractWith(repoSkillMd, repoRegistry, NO_GIT_TRACKER);

		expect(withTracker.linked).not.toContain(ignoredNoteMd);
		expect(withoutTracker.linked).not.toContain(ignoredNoteMd);
		// The disagreement is confined to the one post-snapshot file, not general noise.
		expect(withoutTracker.linked).not.toEqual(withTracker.linked);
	});
});

/**
 * The enumeration this route performs for itself, and the seam that has to see it.
 *
 * `crawlSkillLinkRegistry` is the registry `vat inventory` hands the incumbent
 * link walker, and it is the ONE registry-construction route that enumerates
 * outside `ResourceRegistry` — `crawlDirectory` here, `addResources` there. The
 * class's own bracket cannot reach it, and `resources/test/crawl-timing.test.ts`
 * pins that absence at the class level on purpose.
 *
 * Left uncharged, the missing time is not symmetric between the two crawlers the
 * `crawl` facet exists to compare: this registry is built for the incumbent and
 * never for the projection, so every millisecond of it went missing from exactly
 * the arm a flip decision is taken against, while the projection paid for its own
 * preparation in full. The comparison would have been well-formed and wrong.
 *
 * The counts come from the fixture rather than from literals: a bracket in the
 * wrong place — once per file instead of once per crawl — still produces a
 * plausible-looking number, and only a count tied to the corpus separates them.
 */
describe('crawlSkillLinkRegistry crawl-timing', () => {
	const suite = setupAsyncTempDirSuite('extract-skill-timing');
	let timedRoot = '';

	beforeAll(async () => {
		await suite.beforeAll();
		await suite.beforeEach();
		timedRoot = safePath.join(suite.getTempDir(), 'repo');
		writeRepoFile(timedRoot, SKILL_FILENAME, DIVERGENT_SKILL_MD);
		writeRepoFile(timedRoot, REFERENCE_FILENAME, '# reference\n');
		writeRepoFile(timedRoot, LATE_NOTE_FILENAME, '# late\n');
		commitRepo(timedRoot);
	});

	afterAll(suite.afterAll);

	it('charges its own enumeration, which sits outside the registry class', async () => {
		__setCrawlTimingForTest(safePath.join(suite.getTempDir(), 'timing'));
		try {
			const registry = await crawlSkillLinkRegistry(timedRoot);
			const snapshot = __readCrawlTimingSnapshot();
			const rowFor = (id: string): number =>
				snapshot.entries.find(
					entry => entry.contributorId === id && entry.pass === CRAWL_PASS_INSIDE,
				)?.calls ?? 0;

			// Once per crawl, not once per file — the same accounting unit the
			// class files under this id, which is why they share it.
			expect(rowFor(CRAWL_REGISTRY_ENUMERATE_ID)).toBe(1);
			// And the admission row still counts files, so the enumeration bracket
			// did not swallow the phase after it.
			expect(rowFor(CRAWL_REGISTRY_ADD_RESOURCE_ID)).toBe(registry.size());
			expect(registry.size()).toBeGreaterThan(1);
		} finally {
			__setCrawlTimingForTest(null);
		}
	});

	it('files it on the incumbent arm, which is the arm that builds this registry', async () => {
		__setCrawlTimingForTest(safePath.join(suite.getTempDir(), 'timing-stratum'));
		try {
			await crawlSkillLinkRegistry(timedRoot);
			const enumeration = __readCrawlTimingSnapshot().entries.find(
				entry => entry.contributorId === CRAWL_REGISTRY_ENUMERATE_ID,
			);

			// `recordRegistryPass` inherits the stratum rather than naming one, so
			// this row would follow a projection contributor if one ever called
			// here. Outside a contributor it falls back to the walker's arm, which
			// is where this route's work actually belongs.
			expect(enumeration?.stratum).toBe('crawl');
		} finally {
			__setCrawlTimingForTest(null);
		}
	});
});
