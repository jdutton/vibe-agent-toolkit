/**
 * The tarball lanes that fetch from npm — `vat skills install|list npm:`, `vat claude plugin install
 * npm:` and `vat claude org skills install --from-npm` — against every archive VAT refuses
 * (`describeHostileArchiveLanes`). The local `.tgz` lanes are `archive-hostile-lanes-tar`; the two
 * files split one table only because its over-the-entry-limit row is expensive to build per lane.
 */

// Before anything that loads a command: the npm lane's one seam (`npm pack` is a network call).
import '../fault-matrix/cases/npm-download-mock.js';

import { hostileArchive, tarFixture, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFromNpm } from '../../src/commands/claude/org/skills.js';
import { createPluginCommand } from '../../src/commands/claude/plugin/index.js';
import { packNpmPackage } from '../../src/commands/claude/plugin/npm-pack.js';
import { createSkillsCommand } from '../../src/commands/skills/index.js';
import { archiveLane } from '../helpers/archive-lane-registry.js';
import { type ArchiveLane, describeHostileArchiveLanes, orgLane, pluginPackage, runOnArchive, skillsPackage, SOUND_ROW } from '../helpers/archive-lanes.js';
import { recordingLogger } from '../helpers/upload-logger.js';

const NPM_PACKAGE = 'npm:@fx/fx-pkg';
const USER_SCOPE = ['--target', 'claude', '--scope', 'user'] as const;

const LANES: readonly ArchiveLane[] = [
  { name: archiveLane('vat skills install npm:'), format: 'tar', npm: true, archive: (row) => tarFixture(skillsPackage(row)), group: createSkillsCommand, argv: () => ['install', NPM_PACKAGE, ...USER_SCOPE] },
  // `vat skills list` previews an archive: it extracts it exactly as the install does, and installs nothing.
  { name: archiveLane('vat skills list npm:'), format: 'tar', lists: true, npm: true, archive: (row) => tarFixture(skillsPackage(row)), group: createSkillsCommand, argv: () => ['list', NPM_PACKAGE] },
  { name: archiveLane('vat claude plugin install npm:'), format: 'tar', npm: true, archive: (row) => tarFixture(pluginPackage(row)), group: createPluginCommand, argv: () => ['install', NPM_PACKAGE] },
  orgLane({
    name: archiveLane('vat claude org skills install npm:'),
    format: 'tar',
    npm: true,
    archive: (row) => tarFixture(skillsPackage(row)),
    call: (_archive, client) => installFromNpm('@fx/fx-pkg', undefined, client, recordingLogger()),
  }),
];

describeHostileArchiveLanes('vat-archive-hostile-npm-', LANES);

// Every row above is vacuous for a lane that reached its archive some other way: each asks `npm pack` for it.
const scratch = tempDirTracker('vat-archive-npm-seam-');
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

describe('the npm tarball lanes', () => {
  it.each(LANES)('$name fetches the package through `npm pack`, so its rows reach the real download lane', async (lane) => {
    vi.mocked(packNpmPackage).mockClear();
    await runOnArchive(scratch.create(), lane, { fileName: 'fx-pkg-1.0.0.tgz', bytes: hostileArchive(SOUND_ROW, lane.archive(SOUND_ROW)) });

    expect(vi.mocked(packNpmPackage)).toHaveBeenCalledWith(expect.stringContaining('@fx/fx-pkg'), expect.any(String));
  });
});
