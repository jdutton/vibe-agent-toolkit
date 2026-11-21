/**
 * `vat skill review <dir>` on one skill, held to its counted work, never to time: a guard
 * that fails on a blow-up in work whatever the machine's speed. Each layout runs twice on one
 * `VAT_CACHE_DIR`, cold then warm, and every work counter the run moves is held exactly.
 *
 * - **Alone in its project** (a fresh temp project, no git, no config): one read and one key
 *   of the SKILL.md, two stats, one git call (finding no repository), one admitted registry
 *   member, one derived extent, one skill-text scan, and one parse: a dispatch cold, a
 *   parse-cache hit warm.
 * - **Beside a tree of other markdown** under the same temp parent: exactly the same. The
 *   review never looks past the project it runs in.
 * - **Inside a configured home** (a config, a README and {@link DECOY_FILES} markdown files,
 *   the skill one level down): the review lane crawls a registry view of the whole home by
 *   design (`command-population-matrix.md`), so it admits every markdown file, stats each
 *   twice, and reads and keys each one, warm as well as cold, plus the SKILL.md once more for
 *   its skill text. These counts equal main's and c3236b26f's, measured with the same
 *   layout; this branch adds only the skill-text scans. Held exactly, so the day the
 *   population grows, or someone makes a single review cheaper, this reds and the
 *   expectation is changed on purpose.
 * - **Outside the project it runs in** (the corpus runner's shape: run from inside a
 *   committed, configured project, the skill in a directory beside it): exactly the lone
 *   skill's work, plus one `skillText.outsideRoot`. A stored-document question about a file
 *   outside the run's root opens no store and builds no population of that project to answer it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithWorkCounters } from '../helpers/work-counter-run.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSuiteContext, join, writeFileTree } from './test-common.js';

const context = createSuiteContext('vat-work-skill-review-', import.meta.url);

/** The reviewed skill's SKILL.md. */
const SKILL = '---\nname: reviewed\ndescription: Skill that runs the review pipeline end-to-end so the runner test exercises the with-review path.\n---\n\n# reviewed\n\nBody.\n';

/** Markdown files besides the skill: enough that any walk over them moves a counter by hundreds. */
const DECOY_FILES = 300;

/** {@link DECOY_FILES} linked markdown files, by path under `dir`. */
function decoys(dir: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: DECOY_FILES }, (_, index) => [
    `${dir}/area-${String(index % 10)}/doc-${String(index)}.md`,
    `# Doc ${String(index)}\n\nSee [the next](./doc-${String(index + 1)}.md).\n`,
  ]));
}

/** Where a layout runs the review, what it reviews, and every file it writes under a fresh temp parent. */
interface Layout {
  readonly cwd: string;
  readonly skillDir: string;
  readonly files: Readonly<Record<string, string>>;
}

const ALONE: Layout = { cwd: 'project', skillDir: 'project/reviewed', files: { 'project/reviewed/SKILL.md': SKILL } };
const BESIDE: Layout = { ...ALONE, files: { ...ALONE.files, ...decoys('decoy') } };
const IN_HOME: Layout = {
  cwd: 'home',
  skillDir: 'home/skills/reviewed',
  files: {
    'home/vibe-agent-toolkit.config.yaml': 'resources:\n  include: ["**/*.md"]\nskills:\n  include:\n    - "skills/**/SKILL.md"\n',
    'home/README.md': '# Home\n',
    ...decoys('home/docs'),
    'home/skills/reviewed/SKILL.md': SKILL,
  },
};

/** Where a review's report starts in what it writes. */
const REPORT_START = 'Reviewing skill:';

/** A configured, committed project the review runs from, and the skill beside it, outside it. */
const OUTSIDE: Layout = {
  cwd: 'home',
  skillDir: 'elsewhere/reviewed',
  files: {
    'home/vibe-agent-toolkit.config.yaml': IN_HOME.files['home/vibe-agent-toolkit.config.yaml'] ?? '',
    'home/README.md': '# Home\n',
    ...decoys('home/docs'),
    'elsewhere/reviewed/SKILL.md': SKILL,
  },
};

/** Every counter one review moves but its parse, which is a dispatch cold and a cache hit warm, over `members` admitted files. */
function reviewWork(members: readonly string[], layout: Layout): Record<string, number> {
  const bytes = (path: string): number => Buffer.byteLength(layout.files[path] ?? '');
  const skill = `${layout.skillDir}/SKILL.md`;
  // A lone skill's one admitted member IS its SKILL.md, read once; in a home the SKILL.md is
  // read again for its skill text, past the population's one read of it, by the packaging
  // config's resolution, which runs before the run opens and so has no store to ask: a
  // `skillText.noStore`, never a miss.
  const extraSkillRead = members.length > 1 ? 1 : 0;
  return {
    'content.read': members.length + extraSkillRead,
    'content.hashed': members.length + extraSkillRead,
    'content.hashedBytes': members.reduce((sum, path) => sum + bytes(path), 0) + extraSkillRead * bytes(skill),
    'fs.stat': 2 * members.length,
    'git.calls': 1,
    'registry.built': 1,
    'registry.admitted': members.length,
    'extent.derived': 1,
    'skillText.storeMiss': 1,
    ...(extraSkillRead > 0 && { 'skillText.noStore': extraSkillRead }),
  };
}

/** One review in `layout` under `parent`, the store on or off: its exit code, its report and its one process's moved counters. */
async function runReview(
  parent: string,
  layout: Layout,
  cacheDir: string,
  storeOff: boolean,
): Promise<{ status: number | null; report: string; counters: Record<string, number> }> {
  const { result, dumps } = await runWithWorkCounters(context, join(parent, layout.cwd), ['skill', 'review', join(parent, layout.skillDir)], {
    cacheDir,
    tmpDir: null,
    storeOff,
    probeRoot: null,
  });
  const [dump, ...others] = dumps;
  if (dump === undefined || others.length > 0) throw new Error(`expected one CLI process, got ${String(dumps.length)}`);
  // The report is written to stderr; an operator notice about the store comes before it.
  const reportAt = result.stderr.indexOf(REPORT_START);
  return {
    status: result.status,
    report: reportAt === -1 ? `${result.stdout}\n${result.stderr}` : result.stderr.slice(reportAt),
    counters: Object.fromEntries(Object.entries(dump.counters).filter(([, value]) => value !== 0)),
  };
}

/** One clean review in `layout` under `parent`, the store on: its one process's moved counters. */
async function review(parent: string, layout: Layout, cacheDir: string): Promise<Record<string, number>> {
  const { status, report, counters } = await runReview(parent, layout, cacheDir, false);
  expect(status, report).toBe(0);
  return counters;
}

beforeAll(() => {
  context.setup();
});

afterAll(() => {
  context.cleanup();
});

describe('vat skill review on one skill', () => {
  it.each([
    ['alone in its project', ALONE, [`${ALONE.skillDir}/SKILL.md`]],
    ['beside a tree of other markdown', BESIDE, [`${BESIDE.skillDir}/SKILL.md`]],
    ['inside a configured home', IN_HOME, Object.keys(IN_HOME.files).filter((path) => path.endsWith('.md'))],
  ] as const)('%s: exactly its counted work, cold then warm', async (_label, layout, members) => {
    expect(members.length, 'the home layout admits every markdown file').toBe(layout === IN_HOME ? DECOY_FILES + 2 : 1);
    const parent = context.createTempDir();
    writeFileTree(parent, layout.files);
    const cacheDir = context.createTempDir();
    const work = reviewWork(members, layout);
    // Cold, a lone skill's one parse is dispatched; a home's SKILL.md is parsed once for the
    // population and asked again from the cache for its skill text.
    const coldParses = members.length === 1
      ? { 'parse.dispatched': 1 }
      : { 'parse.dispatched': members.length, 'parse.cache.hit': 1 };
    expect(await review(parent, layout, cacheDir), 'cold').toEqual({ ...work, ...coldParses });
    expect(await review(parent, layout, cacheDir), 'warm').toEqual({ ...work, 'parse.cache.hit': members.length + (members.length > 1 ? 1 : 0) });
  });

  it('outside the project it runs in: exactly the lone skill\'s work, cold then warm', async () => {
    const parent = context.createTempDir();
    writeFileTree(parent, OUTSIDE.files);
    commitTestFixture(join(parent, OUTSIDE.cwd));
    const cacheDir = context.createTempDir();
    const work = reviewWork([`${OUTSIDE.skillDir}/SKILL.md`], OUTSIDE);
    // No git call either: the lone skill's one call was its question's store key, and this
    // question asks for none.
    const outside = { 'skillText.outsideRoot': 1, 'git.calls': undefined };
    expect(await review(parent, OUTSIDE, cacheDir), 'cold').toEqual({ ...work, ...outside, 'parse.dispatched': 1 });
    expect(await review(parent, OUTSIDE, cacheDir), 'warm').toEqual({ ...work, ...outside, 'parse.cache.hit': 1 });
  });

  it('outside the project it runs in: the same findings and exit code, byte for byte, with the store off as on', async () => {
    const parent = context.createTempDir();
    // A finding to compare: a link to a file that is not there.
    writeFileTree(parent, { ...OUTSIDE.files, [`${OUTSIDE.skillDir}/SKILL.md`]: `${SKILL}\nSee [the guide](./references/missing.md).\n` });
    commitTestFixture(join(parent, OUTSIDE.cwd));
    const on = await runReview(parent, OUTSIDE, context.createTempDir(), false);
    const off = await runReview(parent, OUTSIDE, context.createTempDir(), true);
    expect(off.report, 'the store-off reference reports the finding').toContain('LINK_MISSING_TARGET');
    expect({ status: on.status, report: on.report }).toEqual({ status: off.status, report: off.report });
  });
});
