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

/**
 * Run each verb in turn in `repo` over one store, each expected to pass, and return the last
 * run's extent counters.
 */
async function inTurn(repo: string, verbs: ReadonlyArray<readonly string[]>): Promise<Record<'extent.derived' | 'extent.served', number>> {
  const cacheDir = context.createTempDir();
  let last: Record<'extent.derived' | 'extent.served', number> | undefined;
  for (const args of verbs) {
    const run = await runWithWorkCounters(context, repo, [...args], { cacheDir, tmpDir: null, storeOff: false, probeRoot: null, cores: null });
    expect(run.result.status, `${args.join(' ')}:\n${run.result.stdout}\n${run.result.stderr}`).toBe(0);
    last = soleProcessCounters(run, ['extent.derived', 'extent.served']);
  }
  if (last === undefined) throw new Error('no verb ran');
  return last;
}

const VALIDATE = ['resources', 'validate'];
const BUILD = ['skills', 'build'];
const PACKAGE = ['skills', 'package', SKILL, '-o', '../packaged'];
const SERVED_WARM = { 'extent.derived': 0, 'extent.served': 1 };

describe('a validation lane and a build lane over one store', () => {
  beforeAll(() => context.setup());

  afterAll(context.cleanup);

  it('builds and packages after a validation, and the validation after them is served its own extent', async () => {
    expect(await inTurn(linkedCorpus(), [VALIDATE, BUILD, PACKAGE, VALIDATE]), 'the second validation is served warm').toEqual(SERVED_WARM);
  });

  it('validates after a build and a package, and the validation after it is served its own extent', async () => {
    expect(await inTurn(linkedCorpus(), [BUILD, PACKAGE, VALIDATE, VALIDATE]), 'the second validation is served warm').toEqual(SERVED_WARM);
  });
});
