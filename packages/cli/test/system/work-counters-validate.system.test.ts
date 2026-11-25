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
 * - A content-read probe at the `node:fs` boundary (`../helpers/fs-read-probe.cjs`),
 *   which sees a lane that reads around VAT's own read seam. Its positive control
 *   is a file every phase reads, counted at exactly one read.
 *
 * Three corpora, one per shape of the skills phase:
 *
 * - a nested project, so the skills batch spans two roots, each enumerated
 *   through the run's population source;
 * - one root, so the skills view is the shared markdown-only view of the run's
 *   home root, enumerated through the run's population;
 * - a skill outside the project, with no project root of its own.
 *
 * Warm (a second run over the same store), every file under the project root is
 * served from the store: the resources view is admitted from it, and skill
 * discovery and the skills lane read its `skill_text` facts. The run reads, keys
 * and parses only the declared fallback, the skills lane's files outside the
 * project root (which the store does not cover), each once and each counted as a
 * store miss (`skillText.storeMiss`).
 *
 * Every arm has a private `VAT_CACHE_DIR` (where the projection store and the
 * parse cache live) and temp directory, so no other run's cache turns a cold run
 * warm.
 */

import { writeFileSync } from 'node:fs';

import { DEFAULT_PARSE_LIMITS } from '@vibe-agent-toolkit/resources';
import {
  mkdirSyncReal,
  toForwardSlash,
  type WorkCounter,
  type WorkCounterDump,
} from '@vibe-agent-toolkit/utils';
import { createSymlink, parseLookupsIn, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probedReadsOf } from '../helpers/fs-read-probe.js';
import { runWithWorkCounters } from '../helpers/work-counter-run.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, join, writeTestFile } from './test-common.js';

const context = createSuiteContext('vat-work-validate-', import.meta.url);

/** The parse input cap in force (`DEFAULT_PARSE_LIMITS.inputBytes`): one byte past it is refused. */
const INPUT_CAP_BYTES = DEFAULT_PARSE_LIMITS.inputBytes;

/**
 * The root config's skills block. With `declareFiles`, one skill declares a
 * `files:` entry, which makes the resources phase discover the skills (reading
 * each SKILL.md); without it, the skills phase is the first to read them.
 */
function rootConfig(skillsInclude: readonly string[], declareFiles: boolean): string {
  const files = `  config:
    one-admission:
      files:
        - source: scripts/run.mjs
          dest: scripts/run.mjs
`;
  return `resources:
  exclude:
    - "reference/**"
skills:
  include:
${skillsInclude.map((pattern) => `    - "${pattern}"`).join('\n')}
${declareFiles ? files : ''}`;
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
  // A skill linking a skills-only member and an HTML file. Where the corpus
  // declares its `files:` entry, the resources phase discovers skills, and that
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
  /** Whether the skills batch spans several roots. */
  readonly multiRoot: boolean;
  /** Whether a skill declares a `files:` entry, so the resources phase discovers (reads) every SKILL.md. */
  readonly declaresFiles: boolean;
}

/** Two roots: the root project and a nested one whose skill is in the root's pool. */
const NESTED: Corpus = {
  files: {
    ...SHARED_FILES,
    'vibe-agent-toolkit.config.yaml': rootConfig(['skills/**/SKILL.md', 'nested/skills/**/SKILL.md'], true),
    'nested/vibe-agent-toolkit.config.yaml': NESTED_CONFIG,
    'nested/skills/two/SKILL.md': createSkillMarkdown('nested-two'),
  },
  project: '',
  multiRoot: true,
  declaresFiles: true,
};

/**
 * One root: the skills view is the shared markdown-only view of the run's home
 * root. No `files:` entry, so the resources phase discovers no skill and the
 * skills phase reads each SKILL.md itself.
 */
const SINGLE_ROOT: Corpus = {
  files: { ...SHARED_FILES, 'vibe-agent-toolkit.config.yaml': rootConfig(['skills/**/SKILL.md'], false) },
  project: '',
  multiRoot: false,
  declaresFiles: false,
};

/**
 * A skill outside the project, in a directory no config governs: its view is
 * rooted at its own directory. The project is a subdirectory of the repository.
 */
const NO_ROOT: Corpus = {
  files: {
    ...Object.fromEntries(Object.entries(SHARED_FILES).map(([path, content]) => [`project/${path}`, content])),
    'project/vibe-agent-toolkit.config.yaml': rootConfig(['skills/**/SKILL.md', '../loose/**/SKILL.md'], true),
    'loose/rootless/SKILL.md': `${createSkillMarkdown('rootless')}\nSee [its note](./note.md).\n`,
    'loose/rootless/note.md': '# Note\n\nBeside a skill with no project root.\n',
  },
  project: 'project',
  multiRoot: true,
  declaresFiles: true,
};

/** Past the input cap: refused before a byte is read, never keyed. Project-relative. */
const OVER_CAP = 'docs/huge.md';

/** A symlinked alias of `docs/guide.md`, project-relative: declined by the population, so no view admits it. */
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
 * view excluded, and every document of a skill outside the project.
 */
function skillsOnlyDocuments(corpus: Corpus): string[] {
  const resources = new Set(resourcesViewDocuments(corpus));
  const inside = keyedPaths(corpus).filter((path) => isDocument(path) && !resources.has(path));
  return [...inside, ...outsideDocuments(corpus)];
}

/**
 * The SKILL.md files skill discovery reads, repository-relative: every one in the
 * corpus, since each corpus's root config includes all of its skills.
 */
function discoveredSkills(corpus: Corpus): string[] {
  return Object.keys(corpus.files).filter((path) => path.endsWith('/SKILL.md'));
}

/**
 * The files a warm run's skills lane scans from their text (`skillText.storeMiss`), by
 * the phase that first reaches each, repository-relative. The store covers the home
 * root (the project), so the declared fallback is exactly the skills lane's files
 * outside it: a SKILL.md there is read by the phase that discovers skills first (the
 * resources phase when a skill declares `files:`, its deferred-artifact discovery, else
 * the skills phase), and a bundled markdown file there by the skills phase. Every
 * file under the project root is served from the store, so it costs no read, no key
 * and no parse.
 */
function fallbackByPhase(corpus: Corpus): { resources: string[]; skills: string[] } {
  const outside = (path: string): boolean => inProject(corpus, path) === undefined;
  const skillMd = discoveredSkills(corpus).filter((path) => outside(path));
  const bundled = bundledMarkdown(corpus).filter((path) => outside(path));
  return corpus.declaresFiles
    ? { resources: skillMd, skills: bundled }
    : { resources: [], skills: [...skillMd, ...bundled] };
}

/** A relative link target in a document, fragment included. */
const RELATIVE_LINK = /\]\((\.\.?\/[^)\s]*)\)/gu;

/**
 * The markdown files a skill links, repository-relative: what its packaging
 * bundles and scans, so what the skills phase reads.
 */
function bundledMarkdown(corpus: Corpus): string[] {
  const targets = discoveredSkills(corpus).flatMap((skill) => {
    const dir = skill.slice(0, skill.lastIndexOf('/'));
    return [...(corpus.files[skill] ?? '').matchAll(RELATIVE_LINK)]
      .map((match) => (match[1] ?? '').split('#')[0] ?? '')
      .filter((target) => target.endsWith('.md'))
      .map((target) => join(dir, target));
  });
  return [...new Set(targets)];
}

/**
 * Documents a warm run admits from the store, project-relative: every admitted
 * document under the project root (the run's home root, which the store covers).
 * A document outside the project has no store and is admitted by its read.
 */
function storeAdmittedDocuments(corpus: Corpus): string[] {
  const outside = new Set(outsideDocuments(corpus));
  return admittedPaths(corpus).filter((path) => !outside.has(path));
}

/** A path-to-count map as entries sorted by path, for an order-free comparison. */
function sortedEntries(counts: ReadonlyMap<string, number>): Array<[string, number]> {
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

/** The total byte length of some corpus files, repository-relative. */
function bytesOf(corpus: Corpus, paths: readonly string[]): number {
  return paths.reduce((sum, path) => sum + Buffer.byteLength(corpus.files[path] ?? ''), 0);
}

/** Documents outside the project root (a skill with no project root): no population keys them. */
function outsideDocuments(corpus: Corpus): string[] {
  return Object.keys(corpus.files).filter((path) => inProject(corpus, path) === undefined && isDocument(path));
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

/**
 * Run `vat validate` once in `cwd` and read back what it counted.
 *
 * @param cwd - The project root
 * @param arm - Where its caches live
 * @returns The parent's counts, per phase, the children's, and the probe's reads
 */
async function validateCounts(cwd: string, arm: Arm): Promise<RunCounts> {
  // The probe's root is the repository, so a skill outside the project is counted too.
  const { result, dumps: cli, probeDir } = await runWithWorkCounters(context, cwd, ['validate'], {
    cacheDir: arm.storeDir,
    tmpDir: arm.tmpDir,
    storeOff: arm.storeOff,
    probeRoot: join(cwd, '..'),
    cores: null,
  });
  if (probeDir === null) throw new Error('validateCounts runs with the probe');
  // Positive control: both in-process surfaces ran, so the counts cover them.
  expect(result.stdout, result.stderr).toContain('name: resources');
  expect(result.stdout).toContain('name: skills');

  const parent = cli.filter((dump) => 'resources' in dump.phases);
  expect(parent, 'exactly one dump is the validate process').toHaveLength(1);
  const parentDump = parent[0] as WorkCounterDump;
  // Positive control: the probe ran in the parent.
  expect(probedReadsOf(probeDir, (pid) => pid === parentDump.pid).dumps).toBeGreaterThan(0);
  return {
    parent: parentDump.counters,
    phases: parentDump.phases,
    children: summed(cli.filter((dump) => dump !== parentDump).map((dump) => dump.counters)),
    parentReads: probedReadsOf(probeDir, (pid) => pid === parentDump.pid).reads,
    childReads: probedReadsOf(probeDir, (pid) => pid !== parentDump.pid).reads,
    status: result.status,
    stdout: result.stdout,
  };
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
 * The probe's key for a repository-relative path: the probe is rooted one
 * directory above the project, which is the repository's parent for a project at
 * the repository root and the repository itself for a project one level down.
 */
function probedInRepo(cwd: string, corpus: Corpus, path: string): string {
  return corpus.project === '' ? probed(cwd, path) : path;
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
    const outside = outsideDocuments(corpus).length;

    // Positive control: the probe sees a file every phase reads, exactly once.
    expect(parentReads.get(probed(cwd, 'README.md')), 'README.md read exactly once').toBe(1);
    expect(readTwice(parentReads), 'no path read twice at the fs boundary').toEqual([]);
    // The population keys every file under the project root, and a skill
    // outside the project is enumerated for its own root, which reads its documents.
    expect(parent['content.read'], 'content.read = keyed paths, plus what only a skills view reaches').toBe(
      keyedPaths(corpus).length + outside,
    );
    expect(parent['content.hashed'], 'content.hashed = content.read').toBe(parent['content.read']);
    expect(parent['registry.admitted'], 'registry.admitted = admitted subset').toBe(admittedPaths(corpus).length);
    expect(parent['registry.built'], 'one registry per view set').toBe(1);
    // One input cap, the population's: the over-cap file is refused once, by its
    // size before its read, and never reaches a dispatcher under another limit.
    expect(parent['parse.refused.inputCap.read'], 'over-cap file refused once, at its read').toBe(1);
    expect(parent['parse.refused.inputCap.dispatch'], 'no second cap at dispatch').toBe(0);
    if (symlinks !== null) {
      expect(parentReads.get(probed(cwd, ALIAS)) ?? 0, 'the alias is never read').toBe(0);
      expect(storeOnCold.stdout, 'the alias is declined, not silent').toContain(ALIAS);
    }
    if (!corpus.multiRoot) {
      expect(parseLookupsIn(parent), 'parse lookups = parsed subset').toBe(parsedPaths(corpus).length);
    }

    // The checks child asks the store the resources phase wrote: it reads no content.
    expect(children['content.read'] ?? 0, 'checks child content reads').toBe(0);
    expect([...childReads.keys()].filter((path) => !isConfig(path)), 'checks child fs reads').toEqual([]);
  });

  it('warm: every file under the project root is served from the store; the run reads only the skills lane\'s files outside it', async () => {
    const arm = freshArm(false);
    await validateCounts(cwd, arm);
    const warm = await validateCounts(cwd, arm);
    const resources = warm.phases['resources'] as Readonly<Record<WorkCounter, number>>;
    const skills = warm.phases['skills'] as Readonly<Record<WorkCounter, number>>;
    expect(resources).toBeDefined();
    expect(skills).toBeDefined();
    const fallback = fallbackByPhase(corpus);

    // The resources view reads, keys and parses nothing: every member is admitted
    // from the store, and so is the skill discovery a `files:` entry asks for
    // (`computeDeferredArtifacts`). What the phase still reads is the declared
    // fallback: a SKILL.md outside the project, once, its parse answered from the
    // parse cache, and counted as a store miss. The bytes pin the set.
    expect(resources['content.read'], 'resources phase reads only the fallback SKILL.md files').toBe(fallback.resources.length);
    expect(resources['content.hashed'], 'resources phase keys only those').toBe(fallback.resources.length);
    expect(resources['content.hashedBytes'], 'resources phase: exactly the fallback SKILL.md bytes').toBe(bytesOf(corpus, fallback.resources));
    expect(parseLookupsIn(resources), 'resources phase parse lookups: the fallback\'s only').toBe(fallback.resources.length);
    expect(resources['parse.cache.hit'], 'each fallback parse is a cache hit').toBe(fallback.resources.length);
    expect(resources['skillText.storeMiss'], 'resources phase store misses: the fallback SKILL.md files').toBe(fallback.resources.length);
    // A hydrated member costs a readability probe and the registry's one stat:
    // two per view document. The over-cap file is refused from the store once the
    // same probe finds it still readable: one more.
    expect(resources['fs.stat'], 'resources phase: a probe and a stat per hydrated view document, and the over-cap file\'s probe').toBe(
      2 * resourcesViewDocuments(corpus).length + 1,
    );
    expect(resources['registry.admitted'], 'resources phase admits the view, from the store').toBe(resourcesViewDocuments(corpus).length);

    expect(warm.parent['registry.built'], 'one registry per view set').toBe(1);
    expect(warm.parent['registry.admitted'], 'nothing admitted twice').toBe(admittedPaths(corpus).length);
    expect(skills['registry.admitted'], 'the skills phase admits only what no earlier phase admitted').toBe(
      skillsOnlyDocuments(corpus).length,
    );
    // The skills phase reads exactly its fallback: a SKILL.md outside the project
    // that no earlier phase read, and the markdown outside the project a skill
    // links (the packager scans its text). Each once, each a store miss. Its
    // parse lookups are the link walk's, one per bundled fallback file, and one
    // per SKILL.md no earlier phase parsed.
    expect(skills['content.read'], `skills phase content.read = its fallback: ${fallback.skills.join(', ')}`).toBe(fallback.skills.length);
    expect(skills['content.hashed'], 'skills phase keys exactly what it reads').toBe(fallback.skills.length);
    expect(skills['content.hashedBytes'], 'skills phase: exactly the fallback bytes').toBe(bytesOf(corpus, fallback.skills));
    expect(parseLookupsIn(skills), 'skills phase parse lookups: the fallback\'s only').toBe(fallback.skills.length);
    expect(skills['skillText.storeMiss'], 'skills phase store misses: its fallback').toBe(fallback.skills.length);
    expect(warm.parent['skillText.storeMiss'], 'store misses: the declared fallback, nothing else').toBe(
      fallback.resources.length + fallback.skills.length,
    );

    // At the fs boundary, the whole process. The probe counts a read-only open
    // as a content read, so each member admitted from the store shows once for
    // its readability probe (an open and a close, no bytes read), as does the
    // over-cap file before its stored refusal; on top of that, each fallback
    // file is read once.
    const expected = new Map<string, number>();
    const add = (path: string): void => {
      expected.set(path, (expected.get(path) ?? 0) + 1);
    };
    for (const path of storeAdmittedDocuments(corpus)) add(probed(cwd, path));
    add(probed(cwd, OVER_CAP));
    for (const path of [...fallback.resources, ...fallback.skills]) add(probedInRepo(cwd, corpus, path));
    expect(
      sortedEntries(new Map([...warm.parentReads].filter(([path]) => !isConfig(path)))),
      'warm fs-boundary reads: one probe open per store-admitted member, one read per fallback file',
    ).toEqual(sortedEntries(expected));
  });

  it('store off: findings and exit code identical to store on', async () => {
    const off = await validateCounts(cwd, freshArm(true));
    expect(off.status).toBe(storeOnCold.status);
    expect(findingsOf(off.stdout)).toBe(findingsOf(storeOnCold.stdout));
  });
});
