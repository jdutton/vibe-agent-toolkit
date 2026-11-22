/**
 * Warm `vat validate`, `vat skills validate`, `vat resources validate` and `vat verify`
 * read, key and parse no file whose `skill_text` facts the store holds, in any phase:
 * every file the skills lane scans from its text instead (`skillText.storeMiss`) is one
 * the fixture DECLARES the store cannot serve, and the reads, keys and parse lookups a
 * warm run spends are exactly what those declared files cost.
 *
 * The oracle is the fixture's declaration alone ({@link SEEDS}, {@link CATEGORY}): each
 * file is seeded in one category, and each category states, from what makes it a
 * fallback, what the skills lane and the run's first admission of it spend. Nothing
 * here asks the production reader, `storedRoute` or the store which files are served,
 * so a serving path that breaks, or one that serves a file it must not, reds; and every
 * counter is held exactly, both ways.
 *
 * Categories, each a reason the store answers no document for a file
 * (`RunPopulation.storedDocument`):
 *
 * - outside the home root: the store covers the project's own population only;
 * - over the input cap: never keyed, so no facts;
 * - routed to another parser: a collection's `mimeType` keys the file for the HTML
 *   parser, and the skills lane asks for its markdown;
 * - parse refused: the worker refused the parse (`outputRows`), so no `blobs` row and
 *   no facts; the refusal is never filed, so every run's first admission parses it again;
 * - not text: the blob was declined, so it carries no skill-text record;
 * - not held: the record is past the bound the caches hold (`SKILL_TEXT_HELD_LIMITS`),
 *   so its `skill_text_facts` row says `held` false, with no match rows, and neither the
 *   store nor the parse cache answers it;
 * - under outputs: `vat verify`'s marketplace phase validates the built tree, which no
 *   store serves.
 *
 * And three the store DOES serve, held at zero: a plain bundled document, a skill
 * reached by an `include` naming a file that is not `SKILL.md` (every markdown parse
 * records skill text, whatever the file is called), and a bundled document that is not
 * plain UTF-8 (a BOM): the packaging lane scans a document's decoded text, which is
 * what the store's record was built from. Only `validateSkill`'s linked-file lane
 * scans a linked file's raw reading, so for such a file it reads and scans it whether
 * or not the store holds it, a counted miss; none of these verbs runs that lane over a
 * served file, and the skill-text golden test holds it (`NOT_PLAIN_UTF8_LINKED`).
 *
 * The counters are held as counts and bytes; which files they were is held at the
 * `node:fs` boundary (`fs-read-probe`), per verb, as a map from each path to its
 * opens, built from the same declarations and compared whole, both ways. One process's
 * opens are declared by name there: the checks child of `vat validate` re-deriving its
 * tree while that tree holds a parse-refused file (`CHECKS_CHILD_REDERIVES`).
 *
 * Every arm has a private `VAT_CACHE_DIR` and temp directory.
 */

import { cpSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_PARSE_LIMITS, SKILL_TEXT_HELD_LIMITS, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { toForwardSlash, type WorkCounter, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { parseLookupsIn } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { probedReads } from '../helpers/fs-read-probe.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import { runWithWorkCounters } from '../helpers/work-counter-run.js';
import { writeCommittedCorpus } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, executeCli, join, writeFileTree } from './test-common.js';

const context = createSuiteContext('vat-work-skill-text-', import.meta.url);

/** Why the store answers a file's document, or why not. */
type Category = 'served' | 'nonSkillMdInclude' | 'notPlainUtf8' | 'notHeld' | 'outsideHome' | 'overCap' | 'otherParser' | 'parseRefused' | 'notText';

/** Work counted by a run, in one phase or the whole process. */
interface Spend {
  readonly miss: number;
  /** `content.read`: every read of a file's bytes. */
  readonly reads: number;
  /** `content.hashed`: the reads that were keyed. */
  readonly hashed: number;
  readonly lookups: number;
  /** `content.hashedBytes`: the bytes those keyed reads hashed. */
  readonly bytes: number;
}

/** Work, before a file's bytes are known. */
type Cost = Omit<Spend, 'bytes'>;

const NONE: Cost = { miss: 0, reads: 0, hashed: 0, lookups: 0 };

/**
 * What each category costs a warm run, in three parts.
 *
 * - `lane`: what the skills lane spends when it reaches the file (a SKILL.md at
 *   discovery, a bundled document when its skill is packaged). A store miss is
 *   counted once per file per run, and the lane reads it through the run's one
 *   content read, which a file another phase already read costs nothing.
 * - `laneOpens`: the opens that reach costs at the fs boundary. Each counted read is
 *   one; the over-cap document adds its cap check, an open that reads nothing.
 * - `admission`: what the run's first admission of it spends whatever lane asks:
 *   only a parse-refused file, whose refusal no store holds, costs anything.
 */
const CATEGORY: { readonly [Name in Category]: { readonly lane: Cost; readonly laneOpens: number; readonly admission: Cost } } = {
  served: { lane: NONE, laneOpens: 0, admission: NONE },
  nonSkillMdInclude: { lane: NONE, laneOpens: 0, admission: NONE },
  // Served: the packaging lane scans decoded text, the text the store's record was built from.
  notPlainUtf8: { lane: NONE, laneOpens: 0, admission: NONE },
  // No store: read, and its markdown parse (the link walk's) answered from the parse cache.
  outsideHome: { lane: { miss: 1, reads: 1, hashed: 1, lookups: 1 }, laneOpens: 1, admission: NONE },
  // Refused at the run's content read by its size (`parse.refused.inputCap.read`, an open
  // that reads nothing), then read whole by the lane, counted and never keyed: it scans
  // text, it does not parse.
  overCap: { lane: { miss: 1, reads: 1, hashed: 0, lookups: 1 }, laneOpens: 2, admission: NONE },
  // Read for its markdown (the store holds its HTML facts), the markdown parse a cache hit.
  otherParser: { lane: { miss: 1, reads: 1, hashed: 1, lookups: 1 }, laneOpens: 1, admission: NONE },
  // Read and scanned from its text; no parse is asked for: the store holds its other blob
  // facts (links among them), only not its skill-text record.
  notHeld: { lane: { miss: 1, reads: 1, hashed: 1, lookups: 0 }, laneOpens: 1, admission: NONE },
  // Read; a not-text file is never handed to the parser.
  notText: { lane: { miss: 1, reads: 1, hashed: 1, lookups: 0 }, laneOpens: 1, admission: NONE },
  // The first admission reads it and the worker refuses it again (dispatched, then the
  // run's key-determined answer to the second ask); the lane scans that one read's text.
  parseRefused: { lane: { miss: 1, reads: 0, hashed: 0, lookups: 0 }, laneOpens: 0, admission: { miss: 0, reads: 1, hashed: 1, lookups: 2 } },
};

/** What a seeded file is to the skills lane: a skill's SKILL.md (or its non-`SKILL.md` stand-in), or a document a skill bundles. */
type Role = 'skill' | 'bundled';

interface Seed {
  readonly category: Category;
  readonly role: Role;
}

/** The project, a directory of the repository, so a skill can live outside it. */
const PROJECT = 'project';

/** The default parse input cap (`DEFAULT_PARSE_LIMITS.inputBytes`): one byte past it is refused. */
const INPUT_CAP_BYTES = DEFAULT_PARSE_LIMITS.inputBytes;

/** One heading more than the default `outputRows` cap lets a single parse produce. */
const PAST_THE_ROW_CAP = Array.from({ length: DEFAULT_PARSE_LIMITS.outputRows + 1 }, (_, index) => `## h${String(index)}`).join('\n');

/** A markdown document that is not plain UTF-8: a UTF-8 BOM, then its text. */
const NOT_PLAIN_UTF8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM\n\nA bundled document with a byte-order mark.\n')]);

/**
 * One second-person line more than the matches the caches hold of one record
 * (`SKILL_TEXT_HELD_LIMITS.matches`); the imperative family scans the body after a frontmatter block,
 * so the document carries one.
 */
const PAST_THE_HELD_BOUND = 'You should x.\n'.repeat(SKILL_TEXT_HELD_LIMITS.matches + 1);

/** Bytes that are not text, under a markdown name. */
const NOT_TEXT = Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0x0a]);

/** Every file the skills lane reaches, repository-relative, with its declared category. */
const SEEDS: Readonly<Record<string, Seed>> = {
  'project/skills/seeded/SKILL.md': { category: 'served', role: 'skill' },
  'project/skills/seeded/served.md': { category: 'served', role: 'bundled' },
  'project/skills/seeded/bom.md': { category: 'notPlainUtf8', role: 'bundled' },
  'project/skills/seeded/huge.md': { category: 'overCap', role: 'bundled' },
  'project/skills/seeded/big.md': { category: 'notHeld', role: 'bundled' },
  'project/skills/seeded/routed/page.md': { category: 'otherParser', role: 'bundled' },
  'project/skills/seeded/refused.md': { category: 'parseRefused', role: 'bundled' },
  'project/skills/seeded/binary.md': { category: 'notText', role: 'bundled' },
  'project/skills/odd/odd-skill.md': { category: 'nonSkillMdInclude', role: 'skill' },
  'loose/one/SKILL.md': { category: 'outsideHome', role: 'skill' },
  'loose/one/note.md': { category: 'outsideHome', role: 'bundled' },
};

const SKILL_TEXT_CORPUS: Readonly<Record<string, string | Buffer>> = {
  'project/vibe-agent-toolkit.config.yaml': `resources:
  collections:
    as-html:
      include:
        - "skills/seeded/routed/**"
      mimeType: text/html
skills:
  include:
    - "skills/**/SKILL.md"
    - "skills/odd/odd-skill.md"
    - "../loose/**/SKILL.md"
  config:
    seeded:
      files:
        - source: scripts/run.mjs
          dest: scripts/run.mjs
`,
  'project/README.md': '# Corpus\n',
  'project/scripts/run.mjs': 'export {};\n',
  'project/skills/seeded/SKILL.md': `${createSkillMarkdown('seeded')}
See [served](./served.md), [bom](./bom.md), [huge](./huge.md), [big](./big.md), [routed](./routed/page.md), [refused](./refused.md) and [binary](./binary.md).
`,
  'project/skills/seeded/served.md': '# Served\n\nA bundled document the store serves.\n',
  'project/skills/seeded/bom.md': NOT_PLAIN_UTF8,
  'project/skills/seeded/huge.md': `# Huge\n\n${'x'.repeat(INPUT_CAP_BYTES)}\n`,
  'project/skills/seeded/big.md': `---\ntitle: big\n---\n# Big\n\n${PAST_THE_HELD_BOUND}`,
  'project/skills/seeded/routed/page.md': '# Routed\n\nA markdown name a collection keys for the HTML parser.\n',
  'project/skills/seeded/refused.md': `# Refused\n\n${PAST_THE_ROW_CAP}\n`,
  'project/skills/seeded/binary.md': NOT_TEXT,
  'project/skills/odd/odd-skill.md': createSkillMarkdown('odd'),
  'loose/one/SKILL.md': `${createSkillMarkdown('loose')}\nSee [its note](./note.md).\n`,
  'loose/one/note.md': '# Note\n\nBeside a skill outside the project.\n',
};

/** A bounded slice of a run: a phase of `vat validate`, or a whole process. */
type Slice = 'resources' | 'skills' | 'process';

/** Where each verb spends the admission of the resources view, its skill discovery and its packaging. */
interface VerbShape {
  readonly args: readonly string[];
  /** The slices this verb's counters are held in. */
  readonly slices: readonly Slice[];
  readonly admission: Slice;
  readonly discovery: Slice;
  /** Where bundled documents are scanned, or `null` when the verb packages no skill. */
  readonly packaging: Slice | null;
  /** Whether a supervised checks child runs (`vat validate`'s checks phase): it admits the view in a process of its own. */
  readonly checksChild: boolean;
}

const VERBS: Readonly<Record<string, VerbShape>> = {
  'vat validate': { args: ['validate'], slices: ['resources', 'skills'], admission: 'resources', discovery: 'resources', packaging: 'skills', checksChild: true },
  'vat skills validate': { args: ['skills', 'validate'], slices: ['process'], admission: 'process', discovery: 'process', packaging: 'process', checksChild: false },
  'vat resources validate': { args: ['resources', 'validate'], slices: ['process'], admission: 'process', discovery: 'process', packaging: null, checksChild: false },
};

/** The byte length of a seeded file. */
function bytesOf(path: string): number {
  const content = SKILL_TEXT_CORPUS[path];
  return typeof content === 'string' ? Buffer.byteLength(content) : (content?.length ?? 0);
}

/**
 * What a warm run of a verb spends in each slice, from the seeds' declarations alone.
 *
 * @param verb - The verb's shape
 * @returns Slice to its spend
 */
function expectedSpend(verb: VerbShape): Record<string, Spend> {
  const spend: Record<string, Spend> = Object.fromEntries(verb.slices.map((slice) => [slice, { miss: 0, reads: 0, hashed: 0, lookups: 0, bytes: 0 }]));
  const charge = (slice: Slice, path: string, cost: Cost): void => {
    const was = spend[slice];
    if (was === undefined) throw new Error(`${slice} is not one of this verb's slices`);
    spend[slice] = {
      miss: was.miss + cost.miss,
      reads: was.reads + cost.reads,
      hashed: was.hashed + cost.hashed,
      lookups: was.lookups + cost.lookups,
      bytes: was.bytes + cost.hashed * bytesOf(path),
    };
  };
  for (const [path, seed] of Object.entries(SEEDS)) {
    const { lane, admission } = CATEGORY[seed.category];
    // Only files under the project are members of the resources view a run admits.
    if (toForwardSlash(path).startsWith(`${PROJECT}/`)) charge(verb.admission, path, admission);
    const reachedIn = seed.role === 'skill' ? verb.discovery : verb.packaging;
    if (reachedIn !== null) charge(reachedIn, path, lane);
  }
  return spend;
}

/** Every file the project commits but its config, repository-relative: what a process re-deriving the tree reads. */
const TRACKED_PROJECT_FILES = Object.keys(SKILL_TEXT_CORPUS).filter(
  (path) => toForwardSlash(path).startsWith(`${PROJECT}/`) && !path.endsWith('.yaml'),
);

/** The resources view's members: every markdown file under the project, the README with the seeds. */
const VIEW_MEMBERS = TRACKED_PROJECT_FILES.filter((path) => path.endsWith('.md'));

/**
 * `vat validate`'s checks child asks the store for its whole tree, and the store
 * declines a tree holding a pair it refused (`store.miss.refusedPairs`): a
 * parse-refused file's refusal is never filed, so serving the rest would hide it. The
 * child then re-derives, reading every tracked project file once. Declared from the
 * seeds: with no parse-refused seed, the child reads nothing.
 */
const CHECKS_CHILD_REDERIVES = Object.values(SEEDS).some((seed) => seed.category === 'parseRefused');

/**
 * What a warm run of a verb opens at the fs boundary, per path, from the declarations
 * alone: the process that admits the view opens each member once (the store's
 * readability probe, or the read itself), the skills lane adds its category's opens
 * for each file it reaches, and a re-deriving checks child reads its tree once more.
 * Config files are read as config, not content, and are left out.
 *
 * @param verb - The verb's shape
 * @returns Repository-relative path to its opens
 */
function expectedOpens(verb: VerbShape): Map<string, number> {
  const opens = new Map<string, number>();
  const open = (path: string, n: number): void => {
    if (n > 0) opens.set(path, (opens.get(path) ?? 0) + n);
  };
  for (const path of VIEW_MEMBERS) open(path, 1);
  for (const [path, seed] of Object.entries(SEEDS)) {
    const reachedIn = seed.role === 'skill' ? verb.discovery : verb.packaging;
    if (reachedIn !== null) open(path, CATEGORY[seed.category].laneOpens);
  }
  if (verb.checksChild && CHECKS_CHILD_REDERIVES) for (const path of TRACKED_PROJECT_FILES) open(path, 1);
  return opens;
}

/** A probe map with config files left out, sorted for a readable diff. */
function contentOpens(reads: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...reads].filter(([path]) => !path.endsWith('.yaml')).sort(([a], [b]) => (a < b ? -1 : Number(a > b))));
}

/** A run's counters per slice. */
function measuredSpend(dump: WorkCounterDump, verb: VerbShape): Record<string, Spend> {
  const of = (counters: Readonly<Record<WorkCounter, number>>): Spend => ({
    miss: counters['skillText.storeMiss'],
    reads: counters['content.read'],
    hashed: counters['content.hashed'],
    lookups: parseLookupsIn(counters),
    bytes: counters['content.hashedBytes'],
  });
  return Object.fromEntries(verb.slices.map((slice) => {
    const counters = slice === 'process' ? dump.counters : dump.phases[slice];
    if (counters === undefined) throw new Error(`no ${slice} phase in the dump`);
    return [slice, of(counters)];
  }));
}

/** One arm's private caches. */
interface Arm {
  readonly cacheDir: string;
  readonly tmpDir: string;
}

function freshArm(): Arm {
  return { cacheDir: context.createTempDir(), tmpDir: context.createTempDir() };
}

/** A fresh arm holding a copy of another's caches, taken while no run holds them. */
function copyOf(arm: Arm): Arm {
  const copy = freshArm();
  cpSync(arm.cacheDir, copy.cacheDir, { recursive: true });
  return copy;
}

/** What one run left: its exit code, report, its processes' counters and its fs-boundary reads. */
interface Run {
  readonly status: number | null;
  readonly stdout: string;
  /** The one process that built a registry: the verb's own. */
  readonly dump: WorkCounterDump;
  /** Every other CLI process: `vat validate`'s supervised checks child. */
  readonly children: readonly WorkCounterDump[];
  /** Opens per repository-relative path, every process summed. */
  readonly reads: ReadonlyMap<string, number>;
}

/**
 * Run one verb and read back its counters: the one CLI dump that did the verb's work,
 * and the rest (`vat validate`'s checks child).
 *
 * @param cwd - Where it runs
 * @param args - The verb
 * @param arm - Its caches
 * @param storeOff - Whether the store is off
 * @param probeRoot - Under which the fs-boundary probe counts reads
 * @returns The run
 */
async function runVerb(cwd: string, args: readonly string[], arm: Arm, storeOff: boolean, probeRoot: string): Promise<Run> {
  const { result, dumps, probeDir } = await runWithWorkCounters(context, cwd, args, { cacheDir: arm.cacheDir, tmpDir: arm.tmpDir, storeOff, probeRoot });
  if (probeDir === null) throw new Error('runVerb runs with the probe');
  const built = dumps.filter((dump) => dump.counters['registry.built'] > 0);
  expect(built, `${args.join(' ')}: exactly one process built a registry\n${result.stderr}`).toHaveLength(1);
  const dump = built[0] as WorkCounterDump;
  return {
    status: result.status,
    stdout: result.stdout,
    dump,
    children: dumps.filter((other) => other !== dump),
    reads: probedReads(probeDir).reads,
  };
}

/** A report's exit-relevant answer: its findings, as the serialized text a reader compares. */
function findingsText(stdout: string): string {
  const document = parseYaml(stdout) as { findings?: unknown };
  return JSON.stringify(document.findings);
}

/** `vat verify`'s built fixture and its filled caches. */
interface VerifyFixture {
  readonly root: string;
  readonly arm: Arm;
}

/** Prepared beside the first suite's fixture; awaited, and any failure reported, by the suite that uses it. */
let verifyFixture: Promise<VerifyFixture>;

beforeAll(() => {
  context.setup();
  verifyFixture = prepareVerifyFixture();
  // Held until its suite awaits it, so a failure before then is not an unhandled rejection.
  verifyFixture.catch(() => undefined);
});

afterAll(() => {
  context.cleanup();
});

describe('warm skills lanes read only the files the store is declared not to serve', () => {
  /** The caches a populating `vat validate` filled, left as it left them: every verb's warm run is served by a copy. */
  let warm: Arm;
  /** Each verb's warm run, and its store-off run: the oracle the warm run must answer as. */
  let runs: ReadonlyMap<string, { readonly warm: Run; readonly off: Run }>;

  beforeAll(async () => {
    const repo = writeCommittedCorpus(join(context.createTempDir(), 'repo'), SKILL_TEXT_CORPUS);
    const cwd = join(repo, PROJECT);
    warm = freshArm();
    const verbs = Object.entries(VERBS);
    // A store-off run has a fresh arm and reads no store, so it runs beside the populating run.
    const offRuns = Promise.all(verbs.map(async ([, verb]) => runVerb(cwd, verb.args, freshArm(), true, repo)));
    // Awaited below; held so a failure while the populating run is still going is not an unhandled rejection.
    offRuns.catch(() => undefined);
    const populate = await runVerb(cwd, ['validate'], warm, false, repo);
    // Positive control: the populating run was cold, so it scanned every file the skills lane reaches.
    expect(populate.dump.counters['skillText.storeMiss'], 'the populating run scanned every skills-lane file').toBe(Object.keys(SEEDS).length);
    // A warm run may write its caches, so each verb's runs on a private copy of the populated
    // ones, which lets them run side by side and serves each from exactly what populating left.
    const warmRuns = await Promise.all(verbs.map(async ([, verb]) => runVerb(cwd, verb.args, copyOf(warm), false, repo)));
    const off = await offRuns;
    runs = new Map(verbs.map(([name], index) => [name, { warm: warmRuns[index] as Run, off: off[index] as Run }]));
  });

  it.each(Object.entries(VERBS))('%s: misses, reads, keys and parse lookups are exactly the declared fallback\'s, per phase', (name, verb) => {
    const pair = runs.get(name);
    if (pair === undefined) throw new Error(`no runs for ${name}`);
    const { warm: run, off } = pair;
    expect(measuredSpend(run.dump, verb)).toEqual(expectedSpend(verb));
    // Which files: every process's opens, per path, exactly the declared map.
    expect(contentOpens(run.reads), 'opens at the fs boundary, per path').toEqual(contentOpens(expectedOpens(verb)));
    // The checks child is the verb's only other process; it re-derives exactly when declared, and says why.
    const child = { processes: run.children.length, read: 0, hashed: 0, refusedPairs: 0 };
    for (const dump of run.children) {
      child.read += dump.counters['content.read'];
      child.hashed += dump.counters['content.hashed'];
      child.refusedPairs += dump.counters['store.miss.refusedPairs'];
    }
    const rederives = verb.checksChild && CHECKS_CHILD_REDERIVES;
    expect(child, 'the checks child: re-derives its tracked tree only for a refused pair').toEqual({
      processes: verb.checksChild ? 1 : 0,
      read: rederives ? TRACKED_PROJECT_FILES.length : 0,
      hashed: rederives ? TRACKED_PROJECT_FILES.length : 0,
      refusedPairs: rederives ? 1 : 0,
    });
    expect({ status: run.status, findings: findingsText(run.stdout) }, 'warm answers as store-off does').toEqual({
      status: off.status,
      findings: findingsText(off.stdout),
    });
  });

  it('every keyed markdown blob has exactly one skill_text_facts row, and no other blob any skill-text row', () => {
    const [file, ...others] = storeFilesUnder(warm.cacheDir);
    if (file === undefined || others.length > 0) throw new Error('expected one projection store');
    // On a copy: the red below must not damage the store this suite holds.
    const copy = join(context.createTempDir(), 'projection.db');
    const source = new DatabaseSync(file, { readOnly: true });
    try {
      source.prepare('VACUUM INTO ?').run(copy);
    } finally {
      source.close();
    }
    const database = new DatabaseSync(copy);
    try {
      const { violations, checked } = uncoveredBlobs(database);
      // Positive control: the store holds markdown blobs, and a blob of another kind.
      expect(checked.markdown).toBeGreaterThan(1);
      expect(checked.other).toBeGreaterThan(0);
      // And exactly the records the fixture declares past the bound are not held.
      expect(checked.notHeld).toBe(Object.values(SEEDS).filter((seed) => seed.category === 'notHeld').length);
      expect(violations).toEqual([]);
      // The assertion can fail: one row gone, and it names that blob.
      const victim = (database.prepare('SELECT blob FROM skill_text_facts ORDER BY blob LIMIT 1').get() as { blob: string }).blob;
      database.prepare('DELETE FROM skill_text_facts WHERE blob = ?').run(victim);
      expect(uncoveredBlobs(database).violations).toEqual([`${victim}: 0 skill_text_facts rows`]);
    } finally {
      database.close();
    }
  });
});

/**
 * Every blob whose skill-text coverage is wrong, by raw SQL over the store, never its
 * reader: a markdown blob (`blobs` row, key minted for the markdown parser) needs
 * exactly one `skill_text_facts` row, and as many `skill_text_matches` rows as that row's
 * `matchCount` when the row is `held`, none when it is not (a record past the bound);
 * any other blob needs none; and no skill-text row names a blob the
 * `blobs` table does not hold (a parse-refused key has none).
 *
 * @param database - The store, open
 * @returns The violations, and how many blobs of each kind were checked
 */
function uncoveredBlobs(database: DatabaseSync): { violations: string[]; checked: { markdown: number; notHeld: number; other: number } } {
  const rows = database.prepare(`
    SELECT b.contentKey AS blob,
           b.contentKey LIKE 'markdown.%' AS markdown,
           (SELECT COUNT(*) FROM skill_text_facts f WHERE f.blob = b.contentKey) AS facts,
           (SELECT COUNT(*) FROM skill_text_matches m WHERE m.blob = b.contentKey) AS matches,
           (SELECT MAX(f.matchCount) FROM skill_text_facts f WHERE f.blob = b.contentKey) AS matchCount,
           (SELECT MAX(f.held) FROM skill_text_facts f WHERE f.blob = b.contentKey) AS held
    FROM blobs b ORDER BY b.contentKey`).all() as Array<{ blob: string; markdown: number; facts: number; matches: number; matchCount: number | null; held: number | null }>;
  const violations: string[] = [];
  for (const row of rows) {
    if (row.markdown === 1 && row.facts !== 1) violations.push(`${row.blob}: ${String(row.facts)} skill_text_facts rows`);
    const heldMatches = row.held === 1 ? row.matchCount : 0;
    if (row.markdown === 1 && row.facts === 1 && row.matches !== heldMatches) {
      violations.push(`${row.blob}: ${String(row.matches)} skill_text_matches rows for matchCount ${String(row.matchCount)}, held ${String(row.held)}`);
    }
    if (row.markdown === 0 && row.facts + row.matches > 0) violations.push(`${row.blob}: skill-text rows on a blob that is not markdown`);
  }
  const orphans = database.prepare(`
    SELECT blob FROM skill_text_facts WHERE blob NOT IN (SELECT contentKey FROM blobs)
    UNION SELECT blob FROM skill_text_matches WHERE blob NOT IN (SELECT contentKey FROM blobs)`).all() as Array<{ blob: string }>;
  for (const orphan of orphans) violations.push(`${orphan.blob}: skill-text rows with no blobs row`);
  const markdown = rows.filter((row) => row.markdown === 1).length;
  const notHeld = rows.filter((row) => row.markdown === 1 && row.held === 0).length;
  return { violations, checked: { markdown, notHeld, other: rows.length - markdown } };
}

/** The plugin-local skill `vat verify` validates in the source tree and, built, in the marketplace. */
const PLUGIN_SKILL_DIR = 'plugins/one-plugin/skills/one-skill';

/** `vat verify`'s fixture, with each source file the skills lane reaches declared. */
const VERIFY_SEEDS: Readonly<Record<string, Category>> = {
  [`${PLUGIN_SKILL_DIR}/SKILL.md`]: 'served',
  [`${PLUGIN_SKILL_DIR}/served.md`]: 'served',
  [`${PLUGIN_SKILL_DIR}/routed/page.md`]: 'otherParser',
};

const VERIFY_CORPUS: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': `resources:
  collections:
    as-html:
      include:
        - "${PLUGIN_SKILL_DIR}/routed/**"
      mimeType: text/html
skills:
  include:
    - "plugins/one-plugin/skills/**/SKILL.md"
claude:
  marketplaces:
    one-market:
      owner:
        name: Test Org
      plugins:
        - name: one-plugin
          description: A plugin whose one skill is plugin-local
          skills: "*"
`,
  'package.json': JSON.stringify({ name: 'one-corpus', version: '1.0.0' }),
  'README.md': '# Corpus\n',
  [`${PLUGIN_SKILL_DIR}/SKILL.md`]: `${createSkillMarkdown('one-skill')}\nSee [served](./served.md) and [routed](./routed/page.md).\n`,
  [`${PLUGIN_SKILL_DIR}/served.md`]: '# Served\n\nA bundled document the store serves.\n',
  [`${PLUGIN_SKILL_DIR}/routed/page.md`]: '# Routed\n\nA markdown name a collection keys for the HTML parser.\n',
};

/**
 * The parse lookups one `vat verify` run makes of the built SKILL.md, all answered from
 * its one read and its one key: the skill's validation and its skill-text record each
 * ask for the document. The tree under outputs has no store, so each is a parse-cache
 * lookup, never a second read.
 */
const BUILT_SKILL_MD_PARSE_LOOKUPS = 2;

/** Where the build puts the marketplace's copy of the plugin skill, which `vat verify`'s marketplace phase validates. */
const BUILT_SKILL_DIR = 'dist/.claude/plugins/marketplaces/one-market/plugins/one-plugin/skills/one-skill';

/**
 * `vat verify`'s fixture, built, with its caches filled by a first `vat verify`: shares
 * nothing with the other suite's fixture, so it is prepared beside it.
 *
 * @returns The corpus root and the arm its caches are in
 */
async function prepareVerifyFixture(): Promise<VerifyFixture> {
  const root = writeCommittedCorpus(join(context.createTempDir(), 'corpus'), VERIFY_CORPUS);
  const tmp = context.createTempDir();
  const build = await executeCli(context.binPath, ['build'], {
    cwd: root,
    env: { [VAT_CACHE_DIR_ENV]: context.createTempDir(), TMPDIR: tmp, TEMP: tmp, TMP: tmp },
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  // Marketplace validation requires a LICENSE in the built marketplace root.
  writeFileTree(join(root, 'dist/.claude/plugins/marketplaces/one-market'), { LICENSE: 'MIT License - Test' });
  const arm = freshArm();
  await runVerb(root, ['verify'], arm, false, root);
  return { root, arm };
}

describe('warm vat verify reads only the declared fallback and the built tree', () => {
  let root: string;
  let arm: Arm;

  beforeAll(async () => {
    ({ root, arm } = await verifyFixture);
  });

  it('reads, keys, parses and misses exactly the declared source fallback and the built tree', async () => {
    const run = await runVerb(root, ['verify'], arm, false, root);
    expect(run.status, run.stdout).toBe(0);

    const builtSkill = `${BUILT_SKILL_DIR}/SKILL.md`;
    const built = readdirSync(join(root, BUILT_SKILL_DIR), { recursive: true, encoding: 'utf-8' })
      .filter((path) => path.endsWith('.md'))
      .map((path) => `${BUILT_SKILL_DIR}/${toForwardSlash(path)}`);
    expect(built, 'the build bundled the skill and its documents').toHaveLength(Object.keys(VERIFY_SEEDS).length);
    expect(built, 'the built SKILL.md').toContain(builtSkill);
    const sizeOf = (path: string): number => statSync(join(root, path)).size;

    // The source tree costs its declared fallback alone.
    const spend = { miss: 0, noStore: 0, reads: 0, hashed: 0, bytes: 0, lookups: 0 };
    for (const [path, category] of Object.entries(VERIFY_SEEDS)) {
      const { lane } = CATEGORY[category];
      spend.miss += lane.miss;
      spend.reads += lane.reads;
      spend.hashed += lane.hashed;
      spend.bytes += lane.hashed * sizeOf(path);
      spend.lookups += lane.lookups;
    }
    // The built tree is under the verb's outputs, which no store serves, and the marketplace
    // phase validates it with no run (`validateSkill({ run: undefined })` in
    // `claude/marketplace/validate.ts`), so its lane asks no store at all: every built file is
    // read and keyed once and is one `skillText.noStore`, never a miss; the SKILL.md's parse is
    // looked up BUILT_SKILL_MD_PARSE_LOOKUPS times from that one read; each bundled document is
    // scanned, never parsed.
    spend.noStore += built.length;
    spend.reads += built.length;
    spend.hashed += built.length;
    spend.bytes += built.reduce((sum, path) => sum + sizeOf(path), 0);
    spend.lookups += BUILT_SKILL_MD_PARSE_LOOKUPS;
    const counters = run.dump.counters;
    expect({
      miss: counters['skillText.storeMiss'],
      noStore: counters['skillText.noStore'],
      reads: counters['content.read'],
      hashed: counters['content.hashed'],
      bytes: counters['content.hashedBytes'],
      lookups: parseLookupsIn(counters),
    }, 'verify\'s process spend: the source fallback and the built tree').toEqual(spend);
    expect(run.children, 'verify runs in one process').toEqual([]);

    // At the fs boundary: each source file the view admits is opened once (a probe; the
    // fallback's read besides); the consistency phase reads package.json, the marketplace
    // phase each manifest once and each built file once per counted read.
    const expected = new Map<string, number>([
      ['README.md', 1],
      ['package.json', 1],
      ['dist/.claude/plugins/marketplaces/one-market/.claude-plugin/marketplace.json', 1],
      ['dist/.claude/plugins/marketplaces/one-market/plugins/one-plugin/.claude-plugin/plugin.json', 1],
    ]);
    for (const [path, category] of Object.entries(VERIFY_SEEDS)) expected.set(path, 1 + CATEGORY[category].laneOpens);
    for (const path of built) expected.set(path, 1);
    expect(contentOpens(run.reads), 'warm opens at the fs boundary, per path').toEqual(contentOpens(expected));
  });
});
