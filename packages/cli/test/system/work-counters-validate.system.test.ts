/**
 * `vat validate` admits each file once per run: one read, one key and one
 * admission per file, and each phase reads a view over that one admission.
 *
 * The rule is rule 4 of "Decision: content identity is per source"
 * (docs/architecture/content-keying-and-git.md), within one VAT process; the
 * supervised checks child is a separate process and is listed on its own.
 *
 * Counted, not inferred:
 *
 * - VAT's work counters, from the dump of the `vat validate` process itself
 *   (the one whose dump carries the `resources` phase), split per phase.
 * - A content-read probe at the `node:fs` boundary (`../helpers/fs-read-probe.cts`),
 *   which sees a lane that reads around VAT's own read seam.
 *
 * Every arm has a private store and temp directory (where the parse cache lives),
 * so no other run's cache turns a cold run warm.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  mkdirSyncReal,
  WORK_COUNTERS_ENV,
  type WorkCounter,
  type WorkCounterDump,
} from '@vibe-agent-toolkit/utils';
import { createSymlink, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV, PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
import { probedReads, readProbeEnv } from '../helpers/fs-read-probe.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, executeCli, join, writeTestFile } from './test-common.js';

const context = createSuiteContext('vat-work-validate-', import.meta.url);

/** The parse input cap in force (`DEFAULT_PARSE_LIMITS.inputBytes`): one byte past it is refused. */
const INPUT_CAP_BYTES = 8 * 1024 * 1024;

const ROOT_CONFIG = `resources:
  exclude:
    - "reference/**"
skills:
  include:
    - "skills/**/SKILL.md"
    - "nested/skills/**/SKILL.md"
`;

const NESTED_CONFIG = `skills:
  include:
    - "skills/**/SKILL.md"
`;

const TWIN = '# Twin\n\nSame bytes in two files.\n';

/**
 * The main fixture's regular files, root-relative. Each line names the case it
 * is there for.
 */
const FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': ROOT_CONFIG,
  // A link from a resource to a member only the skills scope admits.
  'README.md': '# Corpus\n\nSee [the guide](./docs/guide.md) and [the hidden page](./reference/hidden.md).\n',
  'docs/guide.md': '# Guide\n\nBack to [the readme](../README.md#corpus).\n',
  // Prose no registry admits: the population keys it and parses it (`text/plain`
  // routes to the markdown parser), and no view admits it.
  'docs/notes.txt': 'plain text, keyed and parsed, never admitted\n',
  // Two files with identical content.
  'docs/twin-a.md': TWIN,
  'docs/twin-b.md': TWIN,
  // A markdown file the skills scope reaches but resources.exclude hides.
  'reference/hidden.md': '# Hidden\n\nOnly a skill reaches this.\n',
  // An id (`reference-shared-md`) shared by an included file and a resources-excluded one.
  'reference-shared.md': '# Shared id, included\n',
  'reference/shared.md': '# Shared id, excluded\n',
  // A skill linking a skills-only member and an HTML file.
  'skills/one/SKILL.md': `${createSkillMarkdown('one-admission')}\nSee [hidden](../../reference/hidden.md) and [the page](./page.html).\n`,
  'skills/one/page.html': '<html><body><h1 id="top">Page</h1></body></html>\n',
  // A nested project with its own config, whose skill is in the root's pool.
  'nested/vibe-agent-toolkit.config.yaml': NESTED_CONFIG,
  'nested/skills/two/SKILL.md': createSkillMarkdown('nested-two'),
};

/** Past the input cap: refused before a byte is read, never keyed. */
const OVER_CAP = 'docs/huge.md';

/** A symlinked alias of `docs/guide.md`: declined, never read. */
const ALIAS = 'docs/alias.md';

/** Config files: read by the config loader in every process, outside the population. */
const CONFIG_FILES = new Set(['vibe-agent-toolkit.config.yaml', 'nested/vibe-agent-toolkit.config.yaml']);

const symlinks = symlinkCapability();

let corpus: string;

/** Whether the probe can parse a path: markdown or HTML. */
function isDocument(path: string): boolean {
  return /\.(?:md|html?)$/u.test(path);
}

/** Paths the population reads and keys: every regular readable file under the cap. */
//
// Every file here is readable: an unreadable file and an unreadable directory
// have their own fixtures, in work-counters-unreadable.system.test.ts.
function keyedPaths(): string[] {
  return Object.keys(FILES);
}

/**
 * One path per distinct document content: the run's dispatcher parses each
 * content key once, so a second file with the same bytes is answered from the
 * run's memo and looks nothing up.
 */
function distinctContents(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = `${path.slice(path.lastIndexOf('.'))}\0${FILES[path] ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse lookups: one per distinct parsed content (the documents, and the prose
 * the population parses), and the over-cap file (refused at its read, which is
 * per path, so its refusal is a lookup).
 */
function parsedPaths(): string[] {
  return [...distinctContents(keyedPaths().filter((path) => isDocument(path) || path.endsWith('.txt'))), OVER_CAP];
}

/** Paths admitted into the run's one registry: the readable documents under the cap. */
function admittedPaths(): string[] {
  return keyedPaths().filter(isDocument);
}

/** A path under a `reference/` directory, which the fixture's `resources.exclude` drops. */
const REFERENCE_DIR = /(?:^|\/)reference\//;

/** The resources view's documents: what `resources.exclude` leaves of the admitted set. */
function resourcesViewDocuments(): string[] {
  return admittedPaths().filter((path) => !REFERENCE_DIR.test(path));
}

/** What the skills phase admits: the documents the resources view excluded and no other phase admitted. */
function skillsOnlyDocuments(): string[] {
  const resources = new Set(resourcesViewDocuments());
  return admittedPaths().filter((path) => !resources.has(path));
}

/** Each skill's SKILL.md and the files it bundles through its links. */
const SKILL_FILE_SET = ['skills/one/SKILL.md', 'reference/hidden.md', 'skills/one/page.html', 'nested/skills/two/SKILL.md'];

beforeAll(() => {
  context.setup();
  corpus = join(context.createTempDir(), 'corpus');
  for (const [path, content] of Object.entries(FILES)) {
    const absolute = join(corpus, path);
    mkdirSyncReal(join(absolute, '..'), { recursive: true });
    writeTestFile(absolute, content);
  }
  writeFileSync(join(corpus, OVER_CAP), `# Huge\n\n${'x'.repeat(INPUT_CAP_BYTES)}\n`);
  if (symlinks !== null) createSymlink(symlinks, 'guide.md', join(corpus, ALIAS), 'file');
  // Committed: the store's key is git's tree hash, so an uncommitted corpus
  // could not be keyed and no arm would be warm.
  commitTestFixture(corpus);
});

afterAll(() => {
  context.cleanup();
});

/** One arm's private store and temp directory, and whether its store is on. */
interface Arm {
  readonly storeDir: string;
  readonly tmpDir: string;
  readonly storeOff: boolean;
}

/** A fresh arm: nothing cached anywhere it can reach. */
function freshArm(storeOff: boolean): Arm {
  return { storeDir: context.createTempDir(), tmpDir: context.createTempDir(), storeOff };
}

/** What one `vat validate` run counted. */
interface RunCounts {
  /** The `vat validate` process's own counters. */
  readonly parent: Readonly<Record<WorkCounter, number>>;
  /** Its counters per phase. */
  readonly phases: Readonly<Record<string, Readonly<Record<WorkCounter, number>>>>;
  /** Every other CLI process's counters, summed: the supervised checks child. */
  readonly children: Readonly<Record<WorkCounter, number>>;
  /** Content reads per path in the parent process, from the probe. */
  readonly parentReads: ReadonlyMap<string, number>;
  /** Content reads per path in the child processes, from the probe. */
  readonly childReads: ReadonlyMap<string, number>;
  /** The run's exit status. */
  readonly status: number | null;
  /** The run's report. */
  readonly stdout: string;
}

/** Sum counter records. */
function summed(records: ReadonlyArray<Readonly<Record<WorkCounter, number>>>): Record<WorkCounter, number> {
  const sum = {} as Record<WorkCounter, number>;
  for (const record of records) {
    for (const [name, value] of Object.entries(record) as Array<[WorkCounter, number]>) sum[name] = (sum[name] ?? 0) + value;
  }
  return sum;
}

/** Probe reads per path, for the dumps whose pid is (or is not) `pid`. */
function readsOf(dumpDir: string, keep: (pid: number) => boolean): Map<string, number> {
  const reads = new Map<string, number>();
  for (const name of readdirSync(dumpDir).filter((entry) => entry.startsWith('reads-'))) {
    const pid = Number(name.split('-')[1]);
    if (!keep(pid)) continue;
    const dump = JSON.parse(readFileSync(join(dumpDir, name), 'utf-8')) as { reads: Record<string, number> };
    for (const [path, count] of Object.entries(dump.reads)) reads.set(path, (reads.get(path) ?? 0) + count);
  }
  return reads;
}

/**
 * Run `vat validate` once and read back what it counted.
 *
 * @param arm - Where its caches live
 * @returns The parent's counts, per phase, the children's, and the probe's reads
 */
async function validateCounts(arm: Arm): Promise<RunCounts> {
  const workDir = context.createTempDir();
  const probeDir = context.createTempDir();
  const result = await executeCli(context.binPath, ['validate'], {
    cwd: corpus,
    env: {
      [PROJECTION_STORE_DIR_ENV]: arm.storeDir,
      ...(arm.storeOff && { [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF }),
      [WORK_COUNTERS_ENV]: workDir,
      TMPDIR: arm.tmpDir,
      TEMP: arm.tmpDir,
      TMP: arm.tmpDir,
      ...readProbeEnv(probeDir, corpus),
    },
  });
  // Positive control: both in-process surfaces ran, so the counts cover them.
  expect(result.stdout, result.stderr).toContain('name: resources');
  expect(result.stdout).toContain('name: skills');

  const cli = readdirSync(workDir)
    .map((name) => JSON.parse(readFileSync(join(workDir, name), 'utf-8')) as WorkCounterDump)
    .filter((dump) => dump.role === 'cli');
  const parent = cli.filter((dump) => 'resources' in dump.phases);
  expect(parent, 'exactly one dump is the validate process').toHaveLength(1);
  const parentDump = parent[0] as WorkCounterDump;
  // Positive control: the probe ran in the parent.
  expect(probedReads(probeDir).dumps).toBeGreaterThan(0);
  return {
    parent: parentDump.counters,
    phases: parentDump.phases,
    children: summed(cli.filter((dump) => dump !== parentDump).map((dump) => dump.counters)),
    parentReads: readsOf(probeDir, (pid) => pid === parentDump.pid),
    childReads: readsOf(probeDir, (pid) => pid !== parentDump.pid),
    status: result.status,
    stdout: result.stdout,
  };
}

/** Parse lookups: every way a parse can be answered. */
function parseLookups(counts: Readonly<Record<WorkCounter, number>>): number {
  return (
    counts['parse.cache.hit'] +
    counts['parse.dispatched'] +
    counts['parse.refused.keyDetermined'] +
    counts['parse.refused.inputCap.read'] +
    counts['parse.refused.inputCap.dispatch'] +
    counts['parse.refused.load']
  );
}

/** Paths the parent's probe saw read more than once, config files aside. */
function readTwice(reads: ReadonlyMap<string, number>): string[] {
  return [...reads].filter(([path, count]) => count > 1 && !CONFIG_FILES.has(path)).map(([path]) => path);
}

/**
 * A report with what may differ between two runs of one tree dropped: timings,
 * and where the population came from (`store` or `derived`), which is the point
 * of the store and not a finding.
 */
function findingsOf(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !/Secs: |Ms: |^\s*population: (?:store|derived)$/u.test(line))
    .join('\n');
}

describe('vat validate admits each file once per run', () => {
  let storeOnCold: RunCounts;

  it('cold: one read, one key and one admission per file, one registry', async () => {
    const arm = freshArm(false);
    storeOnCold = await validateCounts(arm);
    const { parent, children, parentReads, childReads } = storeOnCold;

    expect(parent['content.read'], 'content.read = keyed paths').toBe(keyedPaths().length);
    expect(parent['content.hashed'], 'content.hashed = keyed paths').toBe(keyedPaths().length);
    expect(parseLookups(parent), 'parse lookups = parsed subset').toBe(parsedPaths().length);
    expect(parent['registry.admitted'], 'registry.admitted = admitted subset').toBe(admittedPaths().length);
    expect(parent['registry.built'], 'one registry per view set').toBe(1);
    // One input cap, the population's: the over-cap file is refused once, by its
    // size before its read, and never reaches a dispatcher under another limit.
    expect(parent['parse.refused.inputCap.read'], 'over-cap file refused once, at its read').toBe(1);
    expect(parent['parse.refused.inputCap.dispatch'], 'no second cap at dispatch').toBe(0);
    expect(readTwice(parentReads), 'no path read twice at the fs boundary').toEqual([]);
    if (symlinks !== null) expect(parentReads.get(ALIAS) ?? 0, 'the alias is never read').toBe(0);
    expect(storeOnCold.stdout, 'the alias is declined, not silent').toContain(ALIAS);

    // The checks child asks the store the resources phase wrote: it reads no content.
    expect(children['content.read'] ?? 0, 'checks child content reads').toBe(0);
    expect([...childReads.keys()].filter((path) => !CONFIG_FILES.has(path)), 'checks child fs reads').toEqual([]);
  });

  it('warm: the resources phase hits the parse cache once per distinct view document; nothing is admitted twice', async () => {
    const arm = freshArm(false);
    await validateCounts(arm);
    const warm = await validateCounts(arm);
    const resources = warm.phases['resources'];
    const skills = warm.phases['skills'];
    expect(resources).toBeDefined();
    expect(skills).toBeDefined();

    expect(resources?.['parse.cache.hit'], 'resources phase: one hit per distinct view document').toBe(
      distinctContents(resourcesViewDocuments()).length,
    );
    expect(warm.parent['registry.built'], 'one registry per view set').toBe(1);
    expect(warm.parent['registry.admitted'], 'nothing admitted twice').toBe(admittedPaths().length);
    expect(skills?.['registry.admitted'], 'the skills phase admits only what the resources view excluded').toBe(
      skillsOnlyDocuments().length,
    );
    expect(skills?.['content.read'], 'skills phase reads only its SKILL.md and bundled files').toBeLessThanOrEqual(
      SKILL_FILE_SET.length,
    );
    expect(readTwice(warm.parentReads), 'no path read twice at the fs boundary').toEqual([]);
  });

  it('store off: findings and exit code identical to store on', async () => {
    const off = await validateCounts(freshArm(true));
    expect(off.status).toBe(storeOnCold.status);
    expect(findingsOf(off.stdout)).toBe(findingsOf(storeOnCold.stdout));
  });
});
