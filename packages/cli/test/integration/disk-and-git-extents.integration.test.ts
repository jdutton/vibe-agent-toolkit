/**
 * A cached validation lane and a build lane share one store without serving each other's extent.
 *
 * `resources validate` keys each git member by its object ID and reads its bytes from git; `skills
 * build` and `skills package` key every file from disk. Each kind of run has its own stored extent,
 * so a build after a validation is never handed the validation's content keys (which its disk read
 * would contradict, refusing the link rewrite), and a validation after a build is still served warm
 * from the extent its own kind stored.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithWorkCounters, soleProcessCounters } from '../helpers/work-counter-run.js';
import { createSkillMarkdown, createSuiteContext, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-disk-and-git-extents-', import.meta.url);

const SKILL = 'skills/demo/SKILL.md';

/**
 * A committed corpus: a skill linking a guide, both resources of the project. What the verbs write
 * is ignored (the build's `dist/`) or written beside the repository (the package and its zip), so
 * every verb sees one tree and a validation after a build asks the same question.
 */
function linkedCorpus(): string {
  const repo = join(context.createTempDir(), 'corpus');
  mkdirSyncReal(join(repo, 'skills/demo'), { recursive: true });
  mkdirSyncReal(join(repo, 'docs'), { recursive: true });
  writeTestFile(join(repo, 'vibe-agent-toolkit.config.yaml'), `resources:\n  include: ["**/*.md"]\nskills:\n  include:\n    - "${SKILL}"\n`);
  writeTestFile(join(repo, SKILL), `${createSkillMarkdown('demo')}\nSee [the guide](../../docs/guide.md) for more.\n`);
  writeTestFile(join(repo, 'docs/guide.md'), '# Guide\n\nThe guide, bundled with the skill.\n');
  writeTestFile(join(repo, '.gitignore'), 'dist/\n');
  commitTestFixture(repo);
  return repo;
}

/** One verb's extent counters: whether it derived its extent or was served one. */
type ExtentCounts = Record<'extent.derived' | 'extent.served', number>;

/** Run each verb in turn in `repo` over one store, each expected to pass, and return every run's extent counters. */
async function inTurn(repo: string, verbs: ReadonlyArray<readonly string[]>): Promise<ExtentCounts[]> {
  const cacheDir = context.createTempDir();
  const counts: ExtentCounts[] = [];
  for (const args of verbs) {
    const run = await runWithWorkCounters(context, repo, [...args], { cacheDir, tmpDir: null, storeOff: false, probeRoot: null, cores: null });
    expect(run.result.status, `${args.join(' ')}:\n${run.result.stdout}\n${run.result.stderr}`).toBe(0);
    counts.push(soleProcessCounters(run, ['extent.derived', 'extent.served']));
  }
  return counts;
}

const VALIDATE = ['resources', 'validate'];
const BUILD = ['skills', 'build'];
const PACKAGE = ['skills', 'package', SKILL, '-o', '../packaged'];
const SERVED_WARM = { 'extent.derived': 0, 'extent.served': 1 };
const DERIVED_COLD = { 'extent.derived': 1, 'extent.served': 0 };

describe('a validation lane and a build lane over one store', () => {
  beforeAll(() => context.setup());

  afterAll(context.cleanup);

  it('builds and packages after a validation, and the validation after them is served its own extent', async () => {
    const [first, , , last] = await inTurn(linkedCorpus(), [VALIDATE, BUILD, PACKAGE, VALIDATE]);
    expect(first, 'the first validation derives its extent').toEqual(DERIVED_COLD);
    expect(last, 'the second validation is served warm').toEqual(SERVED_WARM);
  });

  it('validates after a build and a package, and the validation after it is served its own extent', async () => {
    const [, , first, last] = await inTurn(linkedCorpus(), [BUILD, PACKAGE, VALIDATE, VALIDATE]);
    // What tells the two extents apart: the builds stored a disk run's extent of this very tree,
    // so a validation served THAT one would count served 1 here. It derives its own instead, and
    // the validation after it can then only be served the extent a validation stored.
    expect(first, 'the first validation is not served the builds\' disk-keyed extent').toEqual(DERIVED_COLD);
    expect(last, 'the second validation is served warm').toEqual(SERVED_WARM);
  });
});
