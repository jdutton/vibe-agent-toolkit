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
 *   which sees a lane that reads around VAT's own read seam. Its positive control
 *   is a file every phase reads, counted at exactly one read.
 *
 * Three corpora, one per shape of the skills phase:
 *
 * - a nested project, so the skills batch spans two roots and every skills view
 *   walks (as each skill's own registry did in v0.2.0-rc.17);
 * - one root, so the skills view is the shared markdown-only view of the run's
 *   home root, enumerated through the run's population;
 * - a skill outside the project, with no project root of its own.
 *
 * Every arm has a private store and temp directory (where the parse cache lives),
 * so no other run's cache turns a cold run warm.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import {
  mkdirSyncReal,
  toForwardSlash,
  WORK_COUNTERS_ENV,
  type WorkCounter,
  type WorkCounterDump,
} from '@vibe-agent-toolkit/utils';
import { createSymlink, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
import { probedReads, readProbeEnv } from '../helpers/fs-read-probe.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, executeCli, join, writeTestFile } from './test-common.js';

const context = createSuiteContext('vat-work-validate-', import.meta.url);

/** The parse input cap in force (`DEFAULT_PARSE_LIMITS.inputBytes`): one byte past it is refused. */
const INPUT_CAP_BYTES = 8 * 1024 * 1024;

/** The root config's skills block: one skill declaring a `files:` entry. */
function rootConfig(skillsInclude: readonly string[]): string {
  return `resources:
  exclude:
    - "reference/**"
skills:
  include:
${skillsInclude.map((pattern) => `    - "${pattern}"`).join('\n')}
  config:
    one-admission:
      files:
        - source: scripts/run.mjs
          dest: scripts/run.mjs
`;
}

const NESTED_CONFIG = `skills:
  include:
    - "skills/**/SKILL.md"
`;

const TWIN = '# Twin\n\nSame bytes in two files.\n';

/**
 * The files every corpus shares, relative to the project root. Each line names
 * the case it is there for.
 */
const SHARED_FILES: Readonly<Record<string, string>> = {
  // A link from a resource to a member only the skills scope admits.
  'README.md': '# Corpus\n\nSee [the guide](./docs/guide.md) and [the hidden page](./reference/hidden.md).\n',
  'docs/guide.md': '# Guide\n\nBack to [the readme](../README.md#corpus).\n',
  // Prose no registry admits: the population keys it and parses it (`text/plain`
  // routes to the markdown parser), and no view admits it.
  'docs/notes.txt': 'plain text, keyed and parsed, never admitted\n',
  // A file VAT never parses: keyed, never handed to a parser, never admitted.
  'docs/image.png': '\u0089PNG, never parsed\n',
  // Two files with identical content.
  'docs/twin-a.md': TWIN,
  'docs/twin-b.md': TWIN,
  // A markdown file the skills scope reaches but resources.exclude hides.
  'reference/hidden.md': '# Hidden\n\nOnly a skill reaches this.\n',
  // An id (`reference-shared-md`) shared by an included file and a resources-excluded one.
  'reference-shared.md': '# Shared id, included\n',
  'reference/shared.md': '# Shared id, excluded\n',
  // A skill linking a skills-only member and an HTML file, and declaring a
  // `files:` entry, which makes the resources phase discover skills: that
  // discovery must read no SKILL.md the run already read.
  'skills/one/SKILL.md': `${createSkillMarkdown('one-admission')}\nSee [hidden](../../reference/hidden.md) and [the page](./page.html).\n`,
  'skills/one/page.html': '<html><body><h1 id="top">Page</h1></body></html>\n',
  'scripts/run.mjs': 'export {};\n',
};

/** One corpus: its files (repository-relative), the directory `vat validate` runs in, and its shape. */
interface Corpus {
  readonly files: Readonly<Record<string, string>>;
  /** The project root, repository-relative ('' for the repository root). */
  readonly project: string;
  /** Whether the skills batch spans several roots, so every skills view walks. */
  readonly multiRoot: boolean;
}

/** Two roots: the root project and a nested one whose skill is in the root's pool. */
const NESTED: Corpus = {
  files: {
    ...SHARED_FILES,
    'vibe-agent-toolkit.config.yaml': rootConfig(['skills/**/SKILL.md', 'nested/skills/**/SKILL.md']),
    'nested/vibe-agent-toolkit.config.yaml': NESTED_CONFIG,
    'nested/skills/two/SKILL.md': createSkillMarkdown('nested-two'),
  },
  project: '',
  multiRoot: true,
};

/** One root: the skills view is the shared markdown-only view of the run's home root. */
const SINGLE_ROOT: Corpus = {
  files: { ...SHARED_FILES, 'vibe-agent-toolkit.config.yaml': rootConfig(['skills/**/SKILL.md']) },
  project: '',
  multiRoot: false,
};

/**
 * A skill outside the project, in a directory no config governs: its view is
 * rooted at its own directory. The project is a subdirectory of the repository.
 */
const NO_ROOT: Corpus = {
  files: {
    ...Object.fromEntries(Object.entries(SHARED_FILES).map(([path, content]) => [`project/${path}`, content])),
    'project/vibe-agent-toolkit.config.yaml': rootConfig(['skills/**/SKILL.md', '../loose/**/SKILL.md']),
    'loose/rootless/SKILL.md': `${createSkillMarkdown('rootless')}\nSee [its note](./note.md).\n`,
    'loose/rootless/note.md': '# Note\n\nBeside a skill with no project root.\n',
  },
  project: 'project',
  multiRoot: true,
};

/** Past the input cap: refused before a byte is read, never keyed. Project-relative. */
const OVER_CAP = 'docs/huge.md';

/** A symlinked alias of `docs/guide.md`, project-relative: declined by the population, admitted by a walk. */
const ALIAS = 'docs/alias.md';

const symlinks = symlinkCapability();

/** Whether the probe can parse a path: markdown or HTML. */
function isDocument(path: string): boolean {
  return /\.(?:md|html?)$/u.test(path);
}

/** A config file: read by the config loader in every process, outside the population. */
function isConfig(path: string): boolean {
  return path.endsWith('vibe-agent-toolkit.config.yaml');
}

/** A path relative to the project root, or `undefined` for one outside it. */
function inProject(corpus: Corpus, path: string): string | undefined {
  if (corpus.project === '') return path;
  const forward = toForwardSlash(path);
  return forward.startsWith(`${corpus.project}/`) ? forward.slice(corpus.project.length + 1) : undefined;
}

/**
 * Paths the population reads and keys: every regular readable file under the
 * cap beneath the project root (the run's home root), project-relative.
 *
 * Every file here is readable: an unreadable file and an unreadable directory
 * have their own fixtures, in work-counters-unreadable.system.test.ts.
 */
function keyedPaths(corpus: Corpus): string[] {
  return Object.keys(corpus.files).flatMap((path) => inProject(corpus, path) ?? []);
}

/**
 * One path per distinct document content: the run's dispatcher parses each
 * content key once, so a second file with the same bytes is answered from the
 * run's memo and looks nothing up.
 */
function distinctContents(corpus: Corpus, paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const content = corpus.files[corpus.project === '' ? path : `${corpus.project}/${path}`] ?? '';
    const key = `${path.slice(path.lastIndexOf('.'))}\0${content}`;
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
function parsedPaths(corpus: Corpus): string[] {
  return [...distinctContents(corpus, keyedPaths(corpus).filter((path) => isDocument(path) || path.endsWith('.txt'))), OVER_CAP];
}

/** A path under a `reference/` directory, which the fixture's `resources.exclude` drops. */
const REFERENCE_DIR = /(?:^|\/)reference\//;

/** The resources view's documents: the readable documents under the project root, less `resources.exclude`. */
function resourcesViewDocuments(corpus: Corpus): string[] {
  return keyedPaths(corpus).filter((path) => isDocument(path) && !REFERENCE_DIR.test(path));
}

/**
 * Documents only the skills phase admits: the project's documents the resources
 * view excluded, every document of a skill outside the project, and, when the
 * skills views walk, the symlinked alias (a walk admits a link as its own path).
 */
function skillsOnlyDocuments(corpus: Corpus): string[] {
  const resources = new Set(resourcesViewDocuments(corpus));
  const inside = keyedPaths(corpus).filter((path) => isDocument(path) && !resources.has(path));
  return [...inside, ...outsideDocuments(corpus), ...(walkedAlias(corpus) ? [ALIAS] : [])];
}

/** The SKILL.md files outside the project root. */
function outsideSkills(corpus: Corpus): string[] {
  return outsideDocuments(corpus).filter((path) => path.endsWith('/SKILL.md'));
}

/** Documents outside the project root (a skill with no project root): no population keys them. */
function outsideDocuments(corpus: Corpus): string[] {
  return Object.keys(corpus.files).filter((path) => inProject(corpus, path) === undefined && isDocument(path));
}

/** Whether a skills view walks over the alias: a multi-root batch walks, and the alias exists. */
function walkedAlias(corpus: Corpus): boolean {
  return corpus.multiRoot && symlinks !== null;
}

/** Every document the run admits, in one view or another. */
function admittedPaths(corpus: Corpus): string[] {
  return [...resourcesViewDocuments(corpus), ...skillsOnlyDocuments(corpus)];
}

/** Write a corpus and commit it; returns the directory `vat validate` runs in. */
function plant(corpus: Corpus): string {
  const repo = join(context.createTempDir(), 'corpus');
  for (const [path, content] of Object.entries(corpus.files)) {
    const absolute = join(repo, path);
    mkdirSyncReal(join(absolute, '..'), { recursive: true });
    writeTestFile(absolute, content);
  }
  const project = corpus.project === '' ? repo : join(repo, corpus.project);
  writeFileSync(join(project, OVER_CAP), `# Huge\n\n${'x'.repeat(INPUT_CAP_BYTES)}\n`);
  if (symlinks !== null) createSymlink(symlinks, 'guide.md', join(project, ALIAS), 'file');
  // Committed: the store's key is git's tree hash, so an uncommitted corpus
  // could not be keyed and no arm would be warm.
  commitTestFixture(repo);
  return project;
}

beforeAll(() => {
  context.setup();
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
  /** Content reads per path in the parent process, from the probe, relative to the probe's root. */
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
 * Run `vat validate` once in `cwd` and read back what it counted.
 *
 * @param cwd - The project root
 * @param arm - Where its caches live
 * @returns The parent's counts, per phase, the children's, and the probe's reads
 */
async function validateCounts(cwd: string, arm: Arm): Promise<RunCounts> {
  const workDir = context.createTempDir();
  const probeDir = context.createTempDir();
  const result = await executeCli(context.binPath, ['validate'], {
    cwd,
    env: {
      [VAT_CACHE_DIR_ENV]: arm.storeDir,
      ...(arm.storeOff && { [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF }),
      [WORK_COUNTERS_ENV]: workDir,
      TMPDIR: arm.tmpDir,
      TEMP: arm.tmpDir,
      TMP: arm.tmpDir,
      // The probe's root is the repository, so a skill outside the project is counted too.
      ...readProbeEnv(probeDir, join(cwd, '..')),
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
  return [...reads].filter(([path, count]) => count > 1 && !isConfig(path)).map(([path]) => path);
}

/** The probe's key for a project-relative path: the probe is rooted one directory above the project. */
function probed(cwd: string, path: string): string {
  const name = cwd.slice(cwd.lastIndexOf('/') + 1);
  return `${name}/${path}`;
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

describe.each([
  ['a skills batch spanning two roots', NESTED],
  ['one root, its skills view the shared markdown-only view', SINGLE_ROOT],
  ['a skill with no project root', NO_ROOT],
] as const)('vat validate admits each file once per run: %s', (_shape, corpus) => {
  let cwd: string;
  let storeOnCold: RunCounts;

  beforeAll(() => {
    cwd = plant(corpus);
  });

  it('cold: one read, one key and one admission per file, one registry', async () => {
    storeOnCold = await validateCounts(cwd, freshArm(false));
    const { parent, children, parentReads, childReads } = storeOnCold;
    const walked = walkedAlias(corpus) ? 1 : 0;
    const outside = outsideDocuments(corpus).length;

    // Positive control: the probe sees a file every phase reads, exactly once.
    expect(parentReads.get(probed(cwd, 'README.md')), 'README.md read exactly once').toBe(1);
    expect(readTwice(parentReads), 'no path read twice at the fs boundary').toEqual([]);
    // The population keys every file under the project root; a walking skills
    // view reads the alias, and a skill outside the project its own documents.
    expect(parent['content.read'], 'content.read = keyed paths, plus what only a skills view reaches').toBe(
      keyedPaths(corpus).length + walked + outside,
    );
    expect(parent['content.hashed'], 'content.hashed = content.read').toBe(parent['content.read']);
    expect(parent['registry.admitted'], 'registry.admitted = admitted subset').toBe(admittedPaths(corpus).length);
    expect(parent['registry.built'], 'one registry per view set').toBe(1);
    // One input cap, the population's: the over-cap file is refused once, by its
    // size before its read, and never reaches a dispatcher under another limit.
    expect(parent['parse.refused.inputCap.read'], 'over-cap file refused once, at its read').toBe(1);
    expect(parent['parse.refused.inputCap.dispatch'], 'no second cap at dispatch').toBe(0);
    if (symlinks !== null && !corpus.multiRoot) {
      expect(parentReads.get(probed(cwd, ALIAS)) ?? 0, 'the alias is never read').toBe(0);
      expect(storeOnCold.stdout, 'the alias is declined, not silent').toContain(ALIAS);
    }
    if (!corpus.multiRoot) {
      expect(parseLookups(parent), 'parse lookups = parsed subset').toBe(parsedPaths(corpus).length);
    }

    // The checks child asks the store the resources phase wrote: it reads no content.
    expect(children['content.read'] ?? 0, 'checks child content reads').toBe(0);
    expect([...childReads.keys()].filter((path) => !isConfig(path)), 'checks child fs reads').toEqual([]);
  });

  it('warm: the resources phase hits the parse cache once per distinct view document; nothing is admitted twice', async () => {
    const arm = freshArm(false);
    await validateCounts(cwd, arm);
    const warm = await validateCounts(cwd, arm);
    const resources = warm.phases['resources'];
    const skills = warm.phases['skills'];
    expect(resources).toBeDefined();
    expect(skills).toBeDefined();

    // Plus each SKILL.md outside the project: the `files:` entry makes the
    // resources phase discover skills, and discovery parses one no view admitted yet.
    expect(resources?.['parse.cache.hit'], 'resources phase: one hit per distinct view document, and per outside SKILL.md').toBe(
      distinctContents(corpus, resourcesViewDocuments(corpus)).length
        + outsideSkills(corpus).length,
    );
    expect(warm.parent['registry.built'], 'one registry per view set').toBe(1);
    expect(warm.parent['registry.admitted'], 'nothing admitted twice').toBe(admittedPaths(corpus).length);
    expect(skills?.['registry.admitted'], 'the skills phase admits only what no earlier phase admitted').toBe(
      skillsOnlyDocuments(corpus).length,
    );
    // On a warm run the population is the store's, so a file is read only when a
    // view admits it or discovery reads it: the skills phase reads exactly the
    // documents only it admits, less each outside SKILL.md the resources phase's
    // discovery already read.
    expect(skills?.['content.read'], 'skills phase reads exactly what only it admits, once').toBe(
      skillsOnlyDocuments(corpus).length - outsideSkills(corpus).length,
    );
    expect(readTwice(warm.parentReads), 'no path read twice at the fs boundary').toEqual([]);
  });

  it('store off: findings and exit code identical to store on', async () => {
    const off = await validateCounts(cwd, freshArm(true));
    expect(off.status).toBe(storeOnCold.status);
    expect(findingsOf(off.stdout)).toBe(findingsOf(storeOnCold.stdout));
  });
});
