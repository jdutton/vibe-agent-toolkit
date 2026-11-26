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
import { mkdirSyncReal, toForwardSlash, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { createSymlink, parseLookupsIn, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  expectNoRowDecodedTwice,
  freshValidateArm,
  isConfig,
  isGitInternal,
  probed,
  readTwice,
  validateCounts as validateCountsOf,
  validateCountsSuite,
  type ValidateArm,
  type ValidateRunCounts,
} from '../helpers/work-counters-validate.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, join, writeTestFile } from './test-common.js';

const context = validateCountsSuite('vat-work-validate-', import.meta.url);

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
 * The git objects some corpus files' bytes are, repository-relative: one per distinct content, the
 * run reading each object once however many paths it backs.
 */
function distinctObjects(corpus: Corpus, paths: readonly string[]): number {
  return new Set(paths.map((path) => corpus.files[path] ?? '')).size;
}

/** Repository-relative, from project-relative. */
function inRepo(corpus: Corpus, path: string): string {
  return corpus.project === '' ? path : `${corpus.project}/${path}`;
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

/** A fresh arm: nothing cached anywhere it can reach. */
function freshArm(storeOff: boolean): ValidateArm {
  return freshValidateArm(context, storeOff);
}

/**
 * Run `vat validate` once in `cwd` and read back what it counted; every corpus here has
 * skills, so the skills phase ran too.
 *
 * @param cwd - The project root
 * @param arm - Where its caches live
 * @returns The parent's counts, per phase, the children's, and the probe's reads
 */
async function validateCounts(cwd: string, arm: ValidateArm): Promise<ValidateRunCounts> {
  const counts = await validateCountsOf(context, cwd, arm);
  // Positive control: the skills surface ran, so the counts cover it.
  expect(counts.stdout).toContain('name: skills');
  return counts;
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
  let storeOnCold: ValidateRunCounts;

  beforeAll(() => {
    cwd = plant(corpus);
  });

  it('cold: one read, one key and one admission per file, one registry', async () => {
    storeOnCold = await validateCounts(cwd, freshArm(false));
    const { parent, children, parentReads, childReads } = storeOnCold;

    // Positive control: the probe sees the config every process reads.
    expect(parentReads.get(probed(cwd, 'vibe-agent-toolkit.config.yaml')) ?? 0, 'the probe sees the config read').toBeGreaterThan(0);
    // The snapshot reads its temporary index (git state, not content) once per snapshot.
    expect(readTwice(new Map([...parentReads].filter(([path]) => !isGitInternal(path)))), 'no path read twice at the fs boundary').toEqual([]);
    // Every file is a git member (the corpus is committed): the population keys every file under
    // the project root by its OID and reads its bytes from git's object store, never from disk and
    // never hashed. The run's members are the project root's, so a skill outside the project is no
    // member of them: its documents are read and hashed from disk, as store-off reads them.
    const outside = outsideDocuments(corpus);
    expect(parent['content.read'], 'content.read: only the documents outside the project root').toBe(outside.length);
    expect(parent['content.hashed'], 'content.hashed: only the documents outside the project root').toBe(outside.length);
    expect(parent['content.gitRead'], 'content.gitRead = one per git object of the keyed paths').toBe(
      distinctObjects(corpus, keyedPaths(corpus).map((path) => inRepo(corpus, path))),
    );
    // A member is opened once for its readability probe (an open and a close, no bytes read: the
    // probe at the fs boundary counts a read-only open), so an unreadable one is reported as a disk
    // read would report it.
    for (const path of keyedPaths(corpus).filter((path) => !isConfig(path))) {
      expect(parentReads.get(probed(cwd, path)) ?? 0, `${path}: opened once, for its readability probe`).toBe(1);
    }
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
    expect([...childReads.keys()].filter((path) => !isConfig(path) && !isGitInternal(path)), 'checks child fs reads').toEqual([]);
    expectNoRowDecodedTwice(storeOnCold);
  });

  it('warm: every file under the project root is served from the store; the run reads only the skills lane\'s files outside it', async () => {
    const arm = freshArm(false);
    await validateCounts(cwd, arm);
    const warm = await validateCounts(cwd, arm);
    expectNoRowDecodedTwice(warm);
    const resources = warm.phases['resources'] as Readonly<Record<WorkCounter, number>>;
    const skills = warm.phases['skills'] as Readonly<Record<WorkCounter, number>>;
    expect(resources).toBeDefined();
    expect(skills).toBeDefined();
    const fallback = fallbackByPhase(corpus);

    // The resources view reads, keys and parses nothing: every member is admitted
    // from the store, and so is the skill discovery a `files:` entry asks for
    // (`computeDeferredArtifacts`). What the phase still reads is the declared
    // fallback: a SKILL.md outside the project, once, its parse answered from the
    // parse cache, and counted as a store miss. It is outside the root the run's members
    // are built for, so it is read and hashed from disk; nothing is read from git.
    expect(resources['content.read'], 'resources phase reads only the fallback SKILL.md files, from disk').toBe(fallback.resources.length);
    expect(resources['content.hashed'], 'resources phase hashes only the fallback SKILL.md files').toBe(fallback.resources.length);
    // The bytes pin the set: another file of the same count would hash other bytes.
    expect(resources['content.hashedBytes'], 'resources phase: exactly the fallback SKILL.md bytes').toBe(bytesOf(corpus, fallback.resources));
    expect(resources['content.gitRead'], 'resources phase reads nothing from git').toBe(0);
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
    expect(skills['content.read'], `skills phase content.read = its fallback, from disk: ${fallback.skills.join(', ')}`).toBe(fallback.skills.length);
    expect(skills['content.hashed'], 'skills phase hashes only its fallback').toBe(fallback.skills.length);
    expect(skills['content.hashedBytes'], 'skills phase: exactly the fallback bytes').toBe(bytesOf(corpus, fallback.skills));
    expect(skills['content.gitRead'], 'skills phase reads nothing from git').toBe(0);
    expect(parseLookupsIn(skills), 'skills phase parse lookups: the fallback\'s only').toBe(fallback.skills.length);
    expect(skills['skillText.storeMiss'], 'skills phase store misses: its fallback').toBe(fallback.skills.length);
    expect(warm.parent['skillText.storeMiss'], 'store misses: the declared fallback, nothing else').toBe(
      fallback.resources.length + fallback.skills.length,
    );

    // At the fs boundary, the whole process. The probe counts a read-only open
    // as a content read, so each member admitted from the store shows once for
    // its readability probe (an open and a close, no bytes read), as does the
    // over-cap file before its stored refusal. Each fallback file, outside the
    // project root, is read from disk once (repository-relative: the probe's root is
    // the repository the project is a subdirectory of). Git's own state under `.git/`
    // is not content.
    const expected = new Map<string, number>();
    for (const path of [...storeAdmittedDocuments(corpus), OVER_CAP]) expected.set(probed(cwd, path), 1);
    for (const path of [...fallback.resources, ...fallback.skills]) expected.set(path, 1);
    expect(
      sortedEntries(new Map([...warm.parentReads].filter(([path]) => !isConfig(path) && !isGitInternal(path)))),
      'warm fs-boundary reads: one probe open per store-admitted member, one read per fallback file',
    ).toEqual(sortedEntries(expected));
  });

  it('store off: findings and exit code identical to store on', async () => {
    const off = await validateCounts(cwd, freshArm(true));
    expect(off.status).toBe(storeOnCold.status);
    expect(findingsOf(off.stdout)).toBe(findingsOf(storeOnCold.stdout));
  });
});
