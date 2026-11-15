/**
 * Every verb that extracts or reads a ZIP — `vat skills install`, `vat claude plugin install`,
 * and `vat claude org skills install` (which sends the archive on rather than extracting it) —
 * in process, against every archive VAT refuses (`describeHostileArchiveLanes`), and against
 * every LAYOUT a skill ZIP may and may not have: one rule, three verbs, one table. The tarball
 * lanes are `archive-hostile-lanes-tar`.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveSkillSource } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { type ArchiveFixtureEntry, entryHoldingMoreThanDeclared, tempDirTracker, withUnlistedLocalEntry, zipFixture } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFromLocal } from '../../src/commands/claude/org/skills.js';
import { createPluginCommand } from '../../src/commands/claude/plugin/index.js';
import { createSkillsCommand } from '../../src/commands/skills/index.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { skillMd } from '../fault-matrix/cases/tree-files.js';
import { archiveLane } from '../helpers/archive-lane-registry.js';
import { type ArchiveLane, describeHostileArchiveLanes, LANE_SKILL, orgLane, runOnArchive, skillZip } from '../helpers/archive-lanes.js';
import { recordingLogger } from '../helpers/upload-logger.js';

const LANES: readonly ArchiveLane[] = [
  { name: archiveLane('vat skills install <zip>'), format: 'zip', archive: (row) => zipFixture(skillZip(row)), group: () => createSkillsCommand(), argv: (archive) => ['install', archive, '--target', 'claude', '--scope', 'user'] },
  { name: archiveLane('vat claude plugin install <zip>'), format: 'zip', archive: (row) => zipFixture(skillZip(row)), group: () => createPluginCommand(), argv: (archive) => ['install', archive] },
  // The other accepted layout: the skill's folder, zipped.
  orgLane({
    name: archiveLane('vat claude org skills install <zip>'),
    format: 'zip',
    archive: (row) => zipFixture([{ name: `${LANE_SKILL}/SKILL.md`, data: skillMd(LANE_SKILL) }, ...row.entries(`${LANE_SKILL}/`)]),
    call: (archive, client) => installFromLocal(archive, undefined, client, recordingLogger()),
  }),
];

describeHostileArchiveLanes('vat-archive-hostile-zip-', LANES);

// The fourth lane that reads a ZIP's members: a `url:` skill source (`vat skill test run --with
// <name>=url:…`). Its hostile table runs in agent-skills, which cannot see the CLI's refusal table, so
// the mapping of the member-read code is held here — the error the lane really throws, through the
// CLI's one `refusalCodeOf`.
describe('a url: skill source whose ZIP member holds more than it declares', () => {
  const urlScratch = tempDirTracker('vat-url-entry-unreadable-');
  afterEach(() => urlScratch.cleanupAll());

  it('is refused as INPUT_UNREADABLE, never INTERNAL_ERROR', async () => {
    const root = urlScratch.create();
    const bytes = zipFixture([{ name: 'SKILL.md', data: skillMd(LANE_SKILL) }, ...entryHoldingMoreThanDeclared('')]);
    const zip = safePath.join(root, 'skill.zip');
    writeFileSync(zip, bytes);
    const ctx = { repoRoot: root, stagingRoot: safePath.join(root, 'staging'), fetchCacheDir: safePath.join(root, 'cache') };

    const error = await resolveSkillSource({ url: pathToFileURL(zip).href, sha256: createHash('sha256').update(bytes).digest('hex') }, ctx)
      .then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'ARCHIVE_ENTRY_UNREADABLE', entry: 'guide.md' });
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
  });
});

// --- the one layout rule ----------------------------------------------------------------------

const scratch = tempDirTracker('vat-skill-zip-layout-');
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

const SKILL: ArchiveFixtureEntry = { name: 'SKILL.md', data: skillMd(LANE_SKILL) };
const under = (folder: string): ArchiveFixtureEntry => ({ name: `${folder}/SKILL.md`, data: skillMd(LANE_SKILL) });

/** Every layout a skill ZIP is taken in, and every one it is refused in — by all three verbs alike. */
const LAYOUTS: ReadonlyArray<readonly [what: string, entries: readonly ArchiveFixtureEntry[], taken: boolean]> = [
  ['SKILL.md at the top level', [SKILL, { name: 'references/a.md', data: 'a' }], true],
  ['one top-level folder with SKILL.md directly inside (a folder, compressed)', [{ name: `${LANE_SKILL}/`, kind: 'directory' }, under(LANE_SKILL), { name: `${LANE_SKILL}/references/a.md`, data: 'a' }], true],
  ['that folder beside the `__MACOSX` folder Finder adds', [under(LANE_SKILL), { name: `__MACOSX/${LANE_SKILL}/._SKILL.md`, data: 'x' }], true],
  ['SKILL.md two folders down', [under(`outer/${LANE_SKILL}`)], false],
  ['a folder holding SKILL.md beside another top-level folder', [under(LANE_SKILL), { name: 'other/readme.md', data: 'x' }], false],
  ['a folder holding SKILL.md beside a top-level file', [under(LANE_SKILL), { name: 'LICENSE', data: 'x' }], false],
  ['no SKILL.md at all', [{ name: 'readme.txt', data: 'hi' }], false],
];

/** What macOS adds to a ZIP it makes: resource forks under `__MACOSX/`, and a `.DS_Store`. */
const HOST_ADDED: readonly ArchiveFixtureEntry[] = [{ name: '__MACOSX/._SKILL.md', data: 'fork' }, { name: '.DS_Store', data: 'store' }];

// The layout rule does not count them as entries of the skill — so they are not installed with it, and
// not sent with it: one predicate (`hostAddedToSkillZip`) decides both.
describe.each(LANES)('what macOS adds beside a skill is left out — $name', (lane) => {
  it.each([
    ['SKILL.md at the top level', [SKILL, ...HOST_ADDED]],
    ['the skill in its one top-level folder', [under(LANE_SKILL), ...HOST_ADDED]],
  ] as const)('%s', async (_what, entries) => {
    const { outcome, homeChanges } = await runOnArchive(scratch.create(), lane, { fileName: `${LANE_SKILL}.zip`, bytes: zipFixture(entries) });

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    const carried = 'sent' in lane ? (lane.sent() ?? Buffer.alloc(0)).toString('latin1') : homeChanges.join('\n');
    // The control: the skill itself went.
    expect(carried).toContain('SKILL.md');
    expect(carried).not.toContain('__MACOSX');
    expect(carried).not.toContain('.DS_Store');
  });
});

describe.each(LANES)('the skill ZIP layout rule — $name', (lane) => {
  it.each(LAYOUTS)('%s', async (_what, entries, taken) => {
    const { outcome, homeChanges } = await runOnArchive(scratch.create(), lane, { fileName: `${LANE_SKILL}.zip`, bytes: zipFixture(entries) });
    const landed = 'landed' in lane ? lane.landed() : homeChanges.some((change) => change.includes(`${LANE_SKILL}/SKILL.md`));

    if (taken) {
      expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
      expect(landed).toBe(true);
    } else {
      expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
      expect(outcome.message).toContain('is not a skill ZIP');
      expect(landed).toBe(false);
      expect(homeChanges).toEqual([]);
    }
  });
});

// The lane that SENDS an archive sends exactly what VAT judged — its own ZIP of the entries the
// central directory lists — never the operator's bytes, which may hold entries only a reader that
// walks local headers from the front would see.
describe.each(LANES.filter((lane) => 'sent' in lane))('what is sent is what was judged — $name', (lane) => {
  it('leaves out a local entry the central directory does not list', async () => {
    const bytes = withUnlistedLocalEntry(zipFixture([SKILL]), { name: 'evals/answers.json', data: 'the answer key' });
    // The control: the operator's bytes do carry it.
    expect(bytes.toString('latin1')).toContain('evals/answers.json');

    const { outcome } = await runOnArchive(scratch.create(), lane, { fileName: `${LANE_SKILL}.zip`, bytes });

    expect(outcome.exitCode ?? 0, outcome.message).toBe(0);
    const sent = ('sent' in lane ? lane.sent() : undefined)?.toString('latin1') ?? '';
    expect(sent).toContain('SKILL.md');
    expect(sent).not.toContain('evals/answers.json');
  });
});
