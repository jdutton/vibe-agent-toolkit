/**
 * Every verb that extracts a TARBALL — `vat skills install` and `vat claude plugin install`, over
 * a `.tgz` and over an npm package, `vat skills list` over both, and
 * `vat claude org skills install --from-npm` — in process, against every archive VAT refuses
 * (`describeHostileArchiveLanes`). One table, every lane: a lane that grows its own extractor, or
 * forgets the entry policy, goes red here. The ZIP lanes are `archive-hostile-lanes-zip`.
 *
 * The two reproductions that opened this suite are at the bottom: a tarball whose link entries
 * climb out of staging, which an install used to answer by copying a directory the archive did
 * not hold into `~/.claude`, at exit 0.
 */

// Before anything that loads a command: the npm lane's one seam (`npm pack` is a network call).
import '../fault-matrix/cases/npm-download-mock.js';

import { readdirSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { type ArchiveFixtureEntry, tarFixture, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFromNpm } from '../../src/commands/claude/org/skills.js';
import { createPluginCommand } from '../../src/commands/claude/plugin/index.js';
import { createSkillsCommand } from '../../src/commands/skills/index.js';
import { skillMd } from '../fault-matrix/cases/tree-files.js';
import type { CaseRoot } from '../fault-matrix/drive.js';
import { archiveLane } from '../helpers/archive-lane-registry.js';
import { type ArchiveLane, describeHostileArchiveLanes, type LaneRun, orgLane, PACKAGE_JSON, pluginPackage, runOnArchive, skillsPackage } from '../helpers/archive-lanes.js';
import { recordingLogger } from '../helpers/upload-logger.js';

const SKILLS_FLAGS = ['--target', 'claude', '--scope', 'user'] as const;
const skills = (): Command => createSkillsCommand();
const plugin = (): Command => createPluginCommand();

const LANES: readonly ArchiveLane[] = [
  { name: archiveLane('vat skills install <tgz>'), format: 'tar', archive: (row) => tarFixture(skillsPackage(row)), group: skills, argv: (archive) => ['install', archive, ...SKILLS_FLAGS] },
  { name: archiveLane('vat skills install npm:'), format: 'tar', npm: true, archive: (row) => tarFixture(skillsPackage(row)), group: skills, argv: () => ['install', 'npm:@fx/fx-pkg', ...SKILLS_FLAGS] },
  // `vat skills list` previews an archive: it extracts it exactly as the install does, and installs nothing.
  { name: archiveLane('vat skills list <tgz>'), format: 'tar', lists: true, archive: (row) => tarFixture(skillsPackage(row)), group: skills, argv: (archive) => ['list', archive] },
  { name: archiveLane('vat skills list npm:'), format: 'tar', lists: true, npm: true, archive: (row) => tarFixture(skillsPackage(row)), group: skills, argv: () => ['list', 'npm:@fx/fx-pkg'] },
  { name: archiveLane('vat claude plugin install <tgz>'), format: 'tar', archive: (row) => tarFixture(pluginPackage(row)), group: plugin, argv: (archive) => ['install', archive] },
  { name: archiveLane('vat claude plugin install npm:'), format: 'tar', npm: true, archive: (row) => tarFixture(pluginPackage(row)), group: plugin, argv: () => ['install', 'npm:@fx/fx-pkg'] },
  orgLane({
    name: archiveLane('vat claude org skills install npm:'),
    format: 'tar',
    npm: true,
    archive: (row) => tarFixture(skillsPackage(row)),
    call: (_archive, client) => installFromNpm('@fx/fx-pkg', undefined, client, recordingLogger()),
  }),
];

describeHostileArchiveLanes('vat-archive-hostile-tar-', LANES);

// --- the reproductions ------------------------------------------------------------------------

const scratch = tempDirTracker('vat-archive-readout-');
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

/** A directory outside the archive, outside staging and outside `$TMPDIR`, holding what an install must never copy. */
function plantVictim(r: CaseRoot): void {
  const victim = safePath.join(r.root, 'victim');
  mkdirSyncReal(safePath.join(victim, 'plugins', 'p'), { recursive: true });
  writeFileSync(safePath.join(victim, 'SKILL.md'), skillMd('victim-skill'));
  writeFileSync(safePath.join(victim, 'PRIVATE.txt'), 'outside the archive and outside staging\n');
  writeFileSync(safePath.join(victim, 'plugins', 'p', 'ALSO-PRIVATE.txt'), 'x\n');
}

/**
 * Links whose every target is textually inside the archive, each really climbing one directory:
 * staging is `<tmp>/vat-…-XXXX`, so `package/c/d` is `package`, `e` is staging, `f` is `<tmp>`,
 * and `f/..` is the case root — where the victim is.
 */
const CLIMB: readonly ArchiveFixtureEntry[] = [
  { name: 'package/c/', kind: 'directory' },
  { name: 'package/c/d', kind: 'link', target: '..' },
  { name: 'package/c/e', kind: 'link', target: 'd/..' },
  { name: 'package/c/f', kind: 'link', target: 'e/..' },
];

/** Every file name under `dir`, however deep, links not followed. */
function fileNamesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).map((entry) => entry.name);
}

const runRepro = (group: () => Command, entries: readonly ArchiveFixtureEntry[], argv: (archive: string) => readonly string[]): Promise<LaneRun> =>
  runOnArchive(scratch.create(), { name: 'repro', group, argv }, { fileName: 'evil-1.0.0.tgz', bytes: tarFixture(entries) }, plantVictim);

/** The lane refused the archive as the input it is, changed nothing under home, and none of `privateFiles` is there. */
function expectNothingReadOut({ r, outcome, homeChanges }: LaneRun, privateFiles: readonly string[]): void {
  expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
  expect(homeChanges).toEqual([]);
  const underHome = fileNamesUnder(r.home);
  for (const name of privateFiles) expect(underHome).not.toContain(name);
}

describe('a tarball whose link entries climb out of staging', () => {
  it('vat skills install: is refused, and no file from outside the archive is installed', async () => {
    const run = await runRepro(skills, [
      PACKAGE_JSON,
      { name: 'package/dist/skills/plain/SKILL.md', data: skillMd('plain') },
      // Stays inside the archive, and leaves the skill once it is installed.
      { name: 'package/dist/skills/plain/keys', kind: 'link', target: '../../../secret' },
      ...CLIMB,
      // Ends `<link>/../victim`, so its lexical form names no link at all (`package/c/victim`).
      { name: 'package/dist/skills/evil', kind: 'link', target: '../../c/f/../victim' },
    ], (archive) => ['install', archive, ...SKILLS_FLAGS]);

    expectNothingReadOut(run, ['PRIVATE.txt']);
  });

  it('vat claude plugin install: is refused, and no directory from outside the archive becomes a marketplace', async () => {
    const run = await runRepro(plugin, [
      PACKAGE_JSON,
      ...CLIMB,
      { name: 'package/dist/.claude/plugins/marketplaces/', kind: 'directory' },
      { name: 'package/dist/.claude/plugins/marketplaces/mp', kind: 'link', target: '../../../../c/f/../victim' },
    ], (archive) => ['install', archive]);

    expectNothingReadOut(run, ['PRIVATE.txt', 'ALSO-PRIVATE.txt']);
  });
});
