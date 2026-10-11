/**
 * No archive lane can go without the hostile-archive table, by omission — nor by a wrapper.
 *
 * `ARCHIVE_READ_SITES` (`helpers/archive-lane-registry.ts`) says which lanes cover each place
 * product source reads an archive. This holds that table to the source and to the suites:
 *
 * - every SITE the scan computes (`helpers/archive-read-sites.ts`: a call, from one file, of an
 *   archive reader or of any function that reaches one, to a fixpoint) is a row of the table, and
 *   every row is still a site;
 * - the scan met nothing it cannot follow: a shape that could reach a reader past it (a namespace
 *   import, a class member, a reader passed as a value, …) FAILS here, naming the file and the
 *   shape, rather than passing unseen. The fixtures at the bottom prove each such shape fails;
 * - every lane the table names is REGISTERED: a suite passes its exact id to `archiveLane(...)`,
 *   unconditionally. A lane's name in a comment, in a skipped block, or under a condition is not.
 *
 * (`describeHostileArchiveLanes` closes the last side at run time: it refuses a lane the table
 * does not name.) What the scan cannot see at all is listed in its header. Integration tier: it
 * reads the repository's source.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { direntKind, pathPresent, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { ARCHIVE_LANE_NAMES, ARCHIVE_READ_SITES } from '../helpers/archive-lane-registry.js';
import { ARCHIVE_SPECIFIER, laneRegistrations, scanReadSites } from '../helpers/archive-read-sites.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

/** The archive module: where the three readers every site leads to are defined. */
const ARCHIVE_MODULE = 'packages/utils/src/archive';

/** Every `.ts` file under `packages/<each>/<sub>`, repo-relative → its text, links not followed. */
function filesOfEveryPackage(sub: 'src' | 'test'): Map<string, string> {
  const files = readdirSync(safePath.join(REPO_ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => direntKind(entry) === 'directory')
    .map((entry) => `packages/${entry.name}/${sub}`)
    .filter((dir) => pathPresent(safePath.join(REPO_ROOT, dir), 'follow', 'source', 'probe'))
    .flatMap((dir) => readdirSync(safePath.join(REPO_ROOT, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => direntKind(entry) === 'file' && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
      .map((entry) => safePath.relative(REPO_ROOT, safePath.join(entry.parentPath, entry.name))));
  return new Map(files.map((file): [string, string] => [file, readFileSync(safePath.join(REPO_ROOT, file), 'utf8')]));
}

const sorted = (values: Iterable<string>): string[] => [...values].sort((a, b) => a.localeCompare(b));

describe('every archive lane runs the hostile-archive table', () => {
  const sources = new Map([...filesOfEveryPackage('src')].filter(([file]) => !toForwardSlash(file).startsWith(ARCHIVE_MODULE)));
  const scan = scanReadSites(sources);
  const registrations = [...filesOfEveryPackage('test')]
    .filter(([file, text]) => text.includes('archiveLane(') && !file.includes('archive-lane-registry') && !file.includes('archive-read-sites') && !file.endsWith('archive-lane-coverage.integration.test.ts'))
    .flatMap(([file, text]) => laneRegistrations(file, text).map((registration) => ({ file, ...registration })));

  it('finds the call sites at all, so the comparisons below cannot pass on an empty scan', () => {
    expect(scan.sites.length).toBeGreaterThanOrEqual(6);
    expect(scan.sites).toContain('packages/cli/src/utils/install-plan.ts › extractArchive');
  });

  // The verb that was missed: it never names an archive reader, only a function that calls one.
  it('counts a verb that reaches an archive through a wrapper as a site', () => {
    expect(scan.sites).toContain('packages/cli/src/commands/skills/list.ts › resolveNpmOrTarballSource');
  });

  it('met no shape it cannot follow', () => {
    expect(scan.unfollowed).toEqual([]);
  });

  it('names every place product source reads an archive, and no place that no longer does', () => {
    expect(scan.sites).toEqual(sorted(Object.keys(ARCHIVE_READ_SITES)));
  });

  it('has a suite registering every lane it names, by its exact id, and no suite registering another', () => {
    expect(sorted(new Set(registrations.filter((each) => each.standing === 'runs').map((each) => each.id)))).toEqual(sorted(ARCHIVE_LANE_NAMES));
  });

  // A registration that may not run is not one: it fails here, whatever else registers the same lane.
  it('has no lane registered under a condition', () => {
    expect(registrations.filter((each) => each.standing === 'conditional').map((each) => `${each.file}: ${each.id}`)).toEqual([]);
  });
});

// --- the scan, over fixtures --------------------------------------------------------------------

const WRAP = 'packages/cli/src/wrap.ts';
const VERB = 'packages/cli/src/verb.ts';
const VIA = 'packages/cli/src/via.ts';

/** A module whose exported `wrap` extracts an archive. */
const WRAPPER = `import { extractArchive } from '${ARCHIVE_SPECIFIER}';\nexport async function wrap(file: string): Promise<void> { await extractArchive({ file, side: 'source' }, '/x', {} as never); }\n`;

const scanOf = (files: Readonly<Record<string, string>>): ReturnType<typeof scanReadSites> => scanReadSites(new Map(Object.entries(files)));

describe('the read-site scan follows a reader however it is imported and exported', () => {
  it.each([
    ['a named import', { [WRAP]: WRAPPER, [VERB]: "import { wrap } from './wrap.js';\nexport const run = (): Promise<void> => wrap('a');\n" }, `${VERB} › wrap`],
    ['an aliased import', { [WRAP]: WRAPPER, [VERB]: "import { wrap as unpack } from './wrap.js';\nexport const run = (): Promise<void> => unpack('a');\n" }, `${VERB} › wrap`],
    ['a destructured dynamic import', { [WRAP]: WRAPPER, [VERB]: "export async function run(): Promise<void> { const { wrap } = await import('./wrap.js'); await wrap('a'); }\n" }, `${VERB} › wrap`],
    ['a re-export by name', { [WRAP]: WRAPPER, [VIA]: "export { wrap as unpack } from './wrap.js';\n", [VERB]: "import { unpack } from './via.js';\nexport const run = (): Promise<void> => unpack('a');\n" }, `${VERB} › wrap`],
    ['a star re-export', { [WRAP]: WRAPPER, [VIA]: "export * from './wrap.js';\n", [VERB]: "import { wrap } from './via.js';\nexport const run = (): Promise<void> => wrap('a');\n" }, `${VERB} › wrap`],
    ['a re-export of the archive module itself', { [VIA]: `export { extractArchive } from '${ARCHIVE_SPECIFIER}';\n`, [VERB]: "import { extractArchive } from './via.js';\nexport const run = (): unknown => extractArchive({} as never, '/x', {} as never);\n" }, `${VERB} › extractArchive`],
    ['an imported binding exported again', { [WRAP]: WRAPPER, [VIA]: "import { wrap } from './wrap.js';\nexport { wrap };\n", [VERB]: "import { wrap } from './via.js';\nexport const run = (): Promise<void> => wrap('a');\n" }, `${VERB} › wrap`],
    ['a wrapper exported through an export list', { [WRAP]: WRAPPER.replace('export async function wrap', 'async function wrap') + 'export { wrap as unpack };\n', [VERB]: "import { unpack } from './wrap.js';\nexport const run = (): Promise<void> => unpack('a');\n" }, `${VERB} › wrap`],
    ['a wrapper exported as default', { [WRAP]: WRAPPER.replace('export async function wrap', 'export default async function wrap'), [VERB]: "import unpack from './wrap.js';\nexport const run = (): Promise<void> => unpack('a');\n" }, `${VERB} › wrap`],
    ['a wrapper of a wrapper', { [WRAP]: WRAPPER, [VIA]: "import { wrap } from './wrap.js';\nexport const outer = (): Promise<void> => wrap('a');\n", [VERB]: "import { outer } from './via.js';\nexport const run = (): Promise<void> => outer();\n" }, `${VERB} › outer`],
  ] as const)('through %s', (_how, files, site) => {
    const scan = scanOf(files);

    expect(scan.unfollowed).toEqual([]);
    expect(scan.sites).toContain(site);
  });

  // The control: a file that reaches no reader is no site, and nothing about it is unfollowed.
  it('finds no site in a file that reaches no reader, however it imports', () => {
    const scan = scanOf({ [VERB]: "import * as path from 'node:path';\nimport * as other from './other.js';\nexport const run = (): string => path.join(other.a, 'b');\n", 'packages/cli/src/other.ts': "export const a = 'a';\n" });

    expect(scan).toEqual({ sites: [], unfollowed: [] });
  });
});

describe('the read-site scan fails closed on a shape it cannot follow', () => {
  it.each([
    ['a namespace import of the archive module', { [VERB]: `import * as archive from '${ARCHIVE_SPECIFIER}';\nexport const run = (): unknown => archive.extractArchive({} as never, '/x', {} as never);\n` }, 'a namespace import (import * as)'],
    ['a namespace import of a wrapper module', { [WRAP]: WRAPPER, [VIA]: "import { wrap } from './wrap.js';\nexport const direct = (): Promise<void> => wrap('a');\n", [VERB]: "import * as plan from './wrap.js';\nexport const run = (): Promise<void> => plan.wrap('a');\n" }, 'a namespace import (import * as)'],
    ['a namespace import of a module that re-exports a reader', { [VIA]: `export * from '${ARCHIVE_SPECIFIER}';\n`, [VERB]: "import * as via from './via.js';\nexport const run = (): unknown => via.extractArchive({} as never, '/x', {} as never);\n" }, 'a namespace import (import * as)'],
    ['a non-destructured dynamic import', { [VERB]: `export async function run(): Promise<unknown> { const archive = await import('${ARCHIVE_SPECIFIER}'); return archive.extractArchive({} as never, '/x', {} as never); }\n` }, 'a non-destructured import()'],
    ['a class method that reaches a reader', { [VERB]: `import { extractArchive } from '${ARCHIVE_SPECIFIER}';\nexport class Installer { run(): unknown { return extractArchive({} as never, '/x', {} as never); } }\n` }, 'a member of class Installer'],
    ['a reader passed as a value', { [VERB]: `import { extractArchive } from '${ARCHIVE_SPECIFIER}';\nexport const READERS = { tar: extractArchive };\n` }, 'extractArchive is used as a value'],
    ['a reader aliased to another name', { [VERB]: `import { extractArchive } from '${ARCHIVE_SPECIFIER}';\nconst unpack = extractArchive;\nexport const run = (): unknown => unpack({} as never, '/x', {} as never);\n` }, 'extractArchive is used as a value'],
  ] as const)('%s', (_shape, files, named) => {
    const { unfollowed } = scanOf(files);

    expect(unfollowed).toHaveLength(1);
    expect(unfollowed[0]).toContain(`${VERB}: `);
    expect(unfollowed[0]).toContain(named);
  });
});

describe('a lane registration counts only when it runs', () => {
  it.each([
    ['at module scope', "const LANES = [{ name: archiveLane('a lane') }];\n", 'runs'],
    ['in a describe', "describe('x', () => { it('y', () => { archiveLane('a lane'); }); });\n", 'runs'],
    ['in a skipped block', "describe.skip('x', () => { archiveLane('a lane'); });\n", 'skipped'],
    ['in a placeholder', "it.todo(archiveLane('a lane'));\n", 'skipped'],
    ['under skipIf', "describe.skipIf(process.platform === 'win32')('x', () => { archiveLane('a lane'); });\n", 'conditional'],
    ['under runIf', "describe.runIf(false)('x', () => { archiveLane('a lane'); });\n", 'conditional'],
    ['under a plain if', "if (process.env['X'] === '1') { describe('x', () => { archiveLane('a lane'); }); }\n", 'conditional'],
    ['in a ternary', "const lane = flag ? archiveLane('a lane') : undefined;\n", 'conditional'],
  ] as const)('%s → %s', (_where, text, standing) => {
    expect(laneRegistrations('x.test.ts', text)).toEqual([{ id: 'a lane', standing }]);
  });

  it('does not read a lane out of a comment or another string', () => {
    expect(laneRegistrations('x.test.ts', "// archiveLane('a lane')\nconst note = \"archiveLane('a lane')\";\n")).toEqual([]);
  });
});
