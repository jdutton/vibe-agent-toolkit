/**
 * The tarball lanes that fetch from npm — `vat skills install|list npm:`, `vat claude plugin install
 * npm:` and `vat claude org skills install --from-npm` — against every archive VAT refuses
 * (`describeHostileArchiveLanes`). The local `.tgz` lanes are `archive-hostile-lanes-tar`; the two
 * files split one table only because its over-the-entry-limit row is expensive to build per lane.
 */

// Before anything that loads a command: the npm lane's one seam (`npm pack` is a network call).
import '../fault-matrix/cases/npm-download-mock.js';

import { tarFixture } from '@vibe-agent-toolkit/utils/testing';

import { installFromNpm } from '../../src/commands/claude/org/skills.js';
import { createPluginCommand } from '../../src/commands/claude/plugin/index.js';
import { createSkillsCommand } from '../../src/commands/skills/index.js';
import { archiveLane } from '../helpers/archive-lane-registry.js';
import { type ArchiveLane, describeHostileArchiveLanes, orgLane, pluginPackage, skillsPackage } from '../helpers/archive-lanes.js';
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
