/**
 * The hostile-archive table (`hostileArchiveRows`) as a suite over the CLI's archive lanes: one
 * registration per lane, every row. Shared by the local-tarball, npm-tarball and ZIP suites, which are
 * three files only because a row holding more entries than the limit is expensive to build once per lane.
 *
 * Each row asserts the same things: the run is refused (exit 2), the refusal is the input's
 * (`INPUT_UNREADABLE`), nothing under `~/.claude` changed, `$TMPDIR` holds no staging, and — for
 * a lane that sends the archive on rather than installing it — nothing was sent.
 *
 * A lane is registered by an id `ARCHIVE_READ_SITES` knows, passed to `archiveLane(...)`
 * (`archive-lane-registry.ts`), which ties each lane to the call sites it covers; an id the table
 * does not hold is refused here.
 */

import { copyFileSync, readdirSync, writeFileSync } from 'node:fs';

import type { OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { ARCHIVE_LIMITS } from '@vibe-agent-toolkit/utils/archive';
import { type ArchiveFixtureEntry, diffSnapshots, entryHoldingMoreThanDeclared, hostileArchive, hostileArchiveRows, type HostileArchiveRow, snapshotTree, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { packNpmPackage } from '../../src/commands/claude/plugin/npm-pack.js';
import { errorMessageOf, refusalCodeOf } from '../../src/utils/command-refusal.js';
import { skillMd } from '../fault-matrix/cases/tree-files.js';
import { makeCaseRoot, runVerb, type CaseRoot, type VerbCase } from '../fault-matrix/drive.js';
import type { VerbOutcome } from '../fault-matrix/invariants.js';

import { ARCHIVE_LANE_NAMES, type ArchiveLaneName } from './archive-lane-registry.js';

export const LANE_SKILL = 'fx-skill';
const PLUGIN_SKILL_DIR = `package/dist/.claude/plugins/marketplaces/fx-mp/plugins/fx-plugin/skills/${LANE_SKILL}/`;
const POOL_SKILL_DIR = `package/dist/skills/${LANE_SKILL}/`;

export const PACKAGE_JSON: ArchiveFixtureEntry = { name: 'package/package.json', data: JSON.stringify({ name: '@fx/fx-pkg', version: '1.0.0' }) };

/** A sound skills package (what `vat skills install` reads): the skill under `dist/skills/`, then a row's entries inside it. */
export const skillsPackage = (row: HostileArchiveRow): ArchiveFixtureEntry[] => [
  PACKAGE_JSON,
  { name: `${POOL_SKILL_DIR}SKILL.md`, data: skillMd(LANE_SKILL) },
  ...row.entries(POOL_SKILL_DIR),
];

/** A sound plugin package (what `vat claude plugin install` reads): one marketplace, one plugin, one skill, then a row's entries inside the skill. */
export const pluginPackage = (row: HostileArchiveRow): ArchiveFixtureEntry[] => [
  PACKAGE_JSON,
  { name: 'package/dist/.claude/plugins/marketplaces/fx-mp/.claude-plugin/marketplace.json', data: JSON.stringify({ name: 'fx-mp', owner: { name: 'fx' }, plugins: [{ name: 'fx-plugin', source: './plugins/fx-plugin' }] }) },
  { name: 'package/dist/.claude/plugins/marketplaces/fx-mp/plugins/fx-plugin/.claude-plugin/plugin.json', data: JSON.stringify({ name: 'fx-plugin', version: '1.0.0' }) },
  { name: `${PLUGIN_SKILL_DIR}SKILL.md`, data: skillMd(LANE_SKILL) },
  ...row.entries(PLUGIN_SKILL_DIR),
];

/** A sound skill ZIP: SKILL.md at its root, then a row's entries beside it. */
export const skillZip = (row: HostileArchiveRow): ArchiveFixtureEntry[] => [{ name: 'SKILL.md', data: skillMd(LANE_SKILL) }, ...row.entries('')];

/** How a lane is run: a verb of the CLI given an argv, or a function called in process (a lane that needs a stand-in API client). */
export type LaneInvocation =
  | {
    readonly group: () => Command;
    readonly argv: (archive: string) => readonly string[];
    /** The verb LISTS what the archive holds and installs nothing: its sound-archive control reads the skill's name off the report. */
    readonly lists?: true;
  }
  | {
    /** Run the lane over the archive at `archive`; a refusal rejects. */
    readonly invoke: (archive: string) => Promise<unknown>;
    /** Whether the last `invoke` got as far as its effect (an upload): the lane's stand-in for "something was installed". */
    readonly landed: () => boolean;
    /** The request body the last `invoke` sent, when it sent one. */
    readonly sent: () => Buffer | undefined;
  };

/** One lane: the archive it takes and what reads it. */
export type ArchiveLane = LaneInvocation & {
  readonly name: ArchiveLaneName;
  readonly format: 'tar' | 'zip';
  /** The whole archive, given a row's hostile entries. */
  readonly archive: (row: HostileArchiveRow) => Buffer;
  /** The lane downloads its archive: the mocked `npm pack` copies it from where the test wrote it. */
  readonly npm?: true;
};

/**
 * A lane of `vat claude org skills install`, which SENDS an archive rather than installing it: run
 * in process against a stand-in Skills API that only counts the uploads it is asked for.
 *
 * @param lane - The lane, with `call` handed the archive's path and the stand-in client
 */
export function orgLane(lane: Pick<ArchiveLane, 'name' | 'format' | 'archive' | 'npm'> & { readonly call: (archive: string, client: OrgApiClient) => Promise<unknown> }): ArchiveLane {
  let uploads = 0;
  let body: Buffer | undefined;
  const client = {
    uploadSkill: (multipart: { readonly body: Buffer }) => {
      uploads += 1;
      body = multipart.body;
      return Promise.resolve({ id: 'skill_fx', display_title: LANE_SKILL, latest_version: '1', created_at: '2026-01-01T00:00:00Z' });
    },
  } as unknown as OrgApiClient;
  const { call, ...rest } = lane;
  return {
    ...rest,
    invoke: async (archive) => {
      uploads = 0;
      body = undefined;
      await call(archive, client);
    },
    landed: () => uploads > 0,
    sent: () => body,
  };
}

/** Run an in-process lane, as the outcome a verb's run has: exit 0, or exit 2 with the refusal its error maps to. */
async function invoked(invoke: (archive: string) => Promise<unknown>, archive: string): Promise<VerbOutcome> {
  try {
    await invoke(archive);
    return { exitCode: 0, refusal: undefined, message: undefined, warnings: [], stdout: '', stderr: '' };
  } catch (error: unknown) {
    return { exitCode: 2, refusal: refusalCodeOf(error), message: errorMessageOf(error), warnings: [], stdout: '', stderr: '', thrown: error };
  }
}

/** Whether a lane's run took the archive: it sent it on, listed its skill, or installed it. */
function took(lane: ArchiveLane, run: LaneRun): boolean {
  if ('landed' in lane) return lane.landed();
  if (lane.lists === true) return run.outcome.stdout.includes(LANE_SKILL);
  return run.homeChanges.some((change) => change.includes(`${LANE_SKILL}/SKILL.md`));
}

/** No hostile entry at all: the positive control of every lane. */
export const SOUND_ROW: HostileArchiveRow = { what: 'nothing hostile', formats: ['tar', 'zip'], reason: 'unreadable', entries: () => [] };
/** The sound archive with one member that holds more than it declares — refused on read, as `ARCHIVE_ENTRY_UNREADABLE`. */
const ENTRY_UNREADABLE_ROW: HostileArchiveRow = { what: 'a member holding more than it declares', formats: ['zip'], reason: 'unsupported', entries: entryHoldingMoreThanDeclared };

export interface LaneRun {
  readonly r: CaseRoot;
  readonly outcome: VerbOutcome;
  /** What changed under the case's home (`~/.claude` included) by the run. */
  readonly homeChanges: string[];
}

/**
 * Run `group`'s verb in a fresh case root over `archive`, written where `argv` is told.
 *
 * @param prepare - Plants anything else the case needs under the root, before the run
 */
export async function runOnArchive(
  root: string,
  lane: LaneInvocation & { readonly name: string; readonly npm?: true },
  archive: { readonly fileName: string; readonly bytes: Buffer },
  prepare: (r: CaseRoot) => void = () => undefined,
): Promise<LaneRun> {
  const r = makeCaseRoot(root);
  prepare(r);
  const input = safePath.join(r.root, 'input');
  mkdirSyncReal(input, { recursive: true });
  const path = safePath.join(input, archive.fileName);
  writeFileSync(path, archive.bytes);
  if (lane.npm === true) {
    // `npm pack` writes the tarball into the download directory: the stand-in copies the fixture there.
    vi.mocked(packNpmPackage).mockImplementation((_name, tempDir) => {
      const packed = safePath.join(tempDir, 'fx-pkg-1.0.0.tgz');
      copyFileSync(path, packed);
      return packed;
    });
  }
  const before = snapshotTree(r.home);
  const outcome = 'invoke' in lane
    ? await invoked(lane.invoke, path)
    : await runVerb({ id: lane.name, group: lane.group, argv: () => lane.argv(path), fixture: () => undefined, watched: () => [], units: () => [], sources: () => [] } satisfies VerbCase, r);
  return { r, outcome, homeChanges: diffSnapshots(before, snapshotTree(r.home)) };
}

/**
 * Register, for each lane, the positive control and one test per hostile row its format can express.
 *
 * @param prefix - The suite's temp-directory prefix, so a leaked directory names it
 * @param lanes - The lanes to run the table through
 */
export function describeHostileArchiveLanes(prefix: string, lanes: readonly ArchiveLane[]): void {
  const unknown = lanes.filter((lane) => !ARCHIVE_LANE_NAMES.has(lane.name)).map((lane) => lane.name);
  if (unknown.length > 0) throw new Error(`describeHostileArchiveLanes: ${unknown.join(', ')} is not a lane ARCHIVE_READ_SITES names — register its call site in archive-lane-registry.ts`);
  const scratch = tempDirTracker(prefix);
  afterEach(() => {
    vi.unstubAllEnvs();
    scratch.cleanupAll();
  });
  const run = (lane: ArchiveLane, row: HostileArchiveRow): Promise<LaneRun> =>
    runOnArchive(scratch.create(), lane, { fileName: lane.format === 'zip' ? `${LANE_SKILL}.zip` : 'fx-pkg-1.0.0.tgz', bytes: hostileArchive(row, lane.archive(row)) });

  describe.each(lanes)('$name', (lane) => {
    // The positive control: the SAME archive without the hostile entries installs, so a refusal below is the row's.
    it('takes the sound archive the rows below are built on', async () => {
      const sound = await run(lane, SOUND_ROW);

      expect(sound.outcome.exitCode ?? 0, sound.outcome.message).toBe(0);
      expect(took(lane, sound)).toBe(true);
    });

    // Not a row of the table: the archive parses and passes the entry policy, and the member is refused
    // only when it is read (`ARCHIVE_ENTRY_UNREADABLE`). The CLI maps that code to INPUT_UNREADABLE; without
    // the mapping it would be INTERNAL_ERROR, at exit 1, on every lane below.
    it.skipIf(lane.format !== 'zip')('refuses a ZIP whose member holds more than it declares as INPUT_UNREADABLE, and installs, lists or sends nothing', async () => {
      const { r, outcome, homeChanges } = await run(lane, ENTRY_UNREADABLE_ROW);

      expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
      expect(outcome.message).toContain('guide.md');
      expect(homeChanges).toEqual([]);
      expect('landed' in lane && lane.landed()).toBe(false);
      expect(readdirSync(r.tmp)).toEqual([]);
    });

    it.each(hostileArchiveRows(ARCHIVE_LIMITS).filter((row) => row.formats.includes(lane.format)))('refuses an archive holding $what, and installs, lists or sends nothing', async (row) => {
      const { r, outcome, homeChanges } = await run(lane, row);

      expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
      expect(homeChanges).toEqual([]);
      expect('landed' in lane && lane.landed()).toBe(false);
      // Staging is disposed of, and nothing was planted beside it.
      expect(readdirSync(r.tmp)).toEqual([]);
      expect(readdirSync(r.root).sort((a, b) => a.localeCompare(b))).toEqual(['home', 'input', 'project', 'tmp']);
    });
  });
}
