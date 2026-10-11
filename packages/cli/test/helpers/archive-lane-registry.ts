/**
 * Every place product source READS an archive, and the lanes that run the hostile-archive table
 * (`hostileArchiveRows`) through it.
 *
 * A site is `<file> › <reader>`: a call, from that file, of a reader defined elsewhere — one of
 * the archive module's (`extractArchive`, `openArchive`, `listArchive`), or any exported function
 * that reaches one (`downloadNpmPackage`, `resolveNpmOrTarballSource`, …). The sites are COMPUTED
 * by `archive-lane-coverage.integration.test.ts`, from the syntax trees and to a fixpoint, and
 * this table is held to them both ways: a site with no row fails it, a row with no site fails it.
 *
 * A lane is the id a suite registers its rows under, by passing it to {@link archiveLane}. The
 * coverage test finds those calls and holds them to the lanes named here, both ways, by exact id;
 * `describeHostileArchiveLanes` refuses a lane this table does not name. So a new lane cannot be
 * added without its rows, and a lane cannot be dropped while its call site stands.
 */
export const ARCHIVE_READ_SITES = {
  // The one extraction of a skill ZIP, and the three verbs that take one through it.
  'packages/cli/src/utils/install-plan.ts › extractArchive': ['vat skills install <zip>', 'vat claude plugin install <zip>', 'vat claude org skills install <zip>'],
  'packages/cli/src/commands/skills/install.ts › extractSkillZip': ['vat skills install <zip>'],
  'packages/cli/src/commands/skills/install.ts › extractTarballToTemp': ['vat skills install <tgz>'],
  'packages/cli/src/commands/skills/install.ts › resolveNpmOrTarballSource': ['vat skills install npm:'],
  'packages/cli/src/commands/skills/list.ts › resolveNpmOrTarballSource': ['vat skills list <tgz>', 'vat skills list npm:'],
  'packages/cli/src/commands/skills/source-resolvers.ts › extractArchive': ['vat skills install <tgz>', 'vat skills list <tgz>'],
  'packages/cli/src/commands/skills/source-resolvers.ts › downloadNpmPackage': ['vat skills install npm:', 'vat skills list npm:'],
  'packages/cli/src/commands/claude/plugin/install.ts › extractSkillZip': ['vat claude plugin install <zip>'],
  'packages/cli/src/commands/claude/plugin/install.ts › extractArchive': ['vat claude plugin install <tgz>'],
  'packages/cli/src/commands/claude/plugin/install.ts › downloadNpmPackage': ['vat claude plugin install npm:'],
  // The one extraction every npm lane shares: reached by each lane that downloads.
  'packages/cli/src/commands/claude/plugin/helpers.ts › extractArchive': ['vat skills install npm:', 'vat skills list npm:', 'vat claude plugin install npm:', 'vat claude org skills install npm:'],
  'packages/cli/src/commands/claude/org/skills.ts › openArchive': ['vat claude org skills install <zip>'],
  'packages/cli/src/commands/claude/org/skills.ts › extractSkillZip': ['vat claude org skills install <zip>'],
  'packages/cli/src/commands/claude/org/skills.ts › downloadNpmPackage': ['vat claude org skills install npm:'],
  // A `url:` skill source, and the chain `vat skill test run --with <name>=url:…` reaches it by. The
  // table is run where the archive is fetched and extracted (`resolveUrlSource`); the three callers
  // above it add nothing an archive passes through.
  'packages/agent-skills/src/skill-source/sources/url-source.ts › extractArchive': ['url: skill source'],
  'packages/agent-skills/src/skill-source/resolve-skill-source.ts › resolveUrlSource': ['url: skill source'],
  'packages/agent-skills/src/skill-test/run-harness.ts › resolveSkillSource': ['url: skill source'],
  'packages/cli/src/commands/skill/test/run.ts › runSkillTestHarness': ['url: skill source'],
} as const satisfies Record<string, readonly string[]>;

/** A lane the table names. */
export type ArchiveLaneName = (typeof ARCHIVE_READ_SITES)[keyof typeof ARCHIVE_READ_SITES][number];

/** Every lane the table names, each once. */
export const ARCHIVE_LANE_NAMES: ReadonlySet<string> = new Set(Object.values(ARCHIVE_READ_SITES).flat());

/**
 * Register a lane: the id a suite runs the hostile-archive table under. The coverage test reads
 * these calls off the suites' syntax trees, so the id is written here as a literal, in a block
 * that runs.
 *
 * @param id - A lane {@link ARCHIVE_READ_SITES} names
 * @returns `id`
 */
export function archiveLane<Id extends ArchiveLaneName>(id: Id): Id {
  return id;
}
