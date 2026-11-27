/**
 * A skill built from a `core.autocrlf=true` checkout ships the working tree's CRLF bytes, links
 * rewritten at the right spans.
 *
 * A build lane reads every file from disk (its `RUN_MEMBER_BYTES` entry is `'disk'`), never from git, even with the
 * store on: what it ships is the checkout. The link spans were parsed from the run's one read of
 * each file, and the rewrite is served that same read, so splicing them into the CRLF text lands
 * each rewrite on its link. Spans parsed from git's LF bytes would land one byte early per line
 * ending before the link, cutting into the prose around it.
 *
 * Each file the build parses and rewrites is read from disk exactly once per run, never from git
 * and never a second time for the rewrite. So is each file `vat skills package` packages: its
 * argument check, its validation gate and its packaging share one read of the SKILL.md.
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';

import { mkdirSyncReal, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_SQLITE } from '../../src/utils/projection-store.js';
import { probedReads } from '../helpers/fs-read-probe.js';
import { runWithWorkCounters, soleProcessCounters } from '../helpers/work-counter-run.js';
import { createSkillMarkdown, createSkillsConfigYaml, createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-skills-autocrlf-', import.meta.url);

const SKILL = 'skills/demo/SKILL.md';
const GUIDE = 'docs/guide.md';

/** Lines before the link, so a CRLF offset would move its span by several bytes. */
const SKILL_BODY = `${createSkillMarkdown('demo')}\nOne line.\nTwo lines.\nThree lines.\n\nSee [the guide](../../docs/guide.md) for more.\n`;
const GUIDE_BODY = '# Guide\n\nThe guide, bundled with the skill.\n';

/** `text` with every LF as CRLF: what the autocrlf checkout writes. */
function crlf(text: string): string {
  return text.replaceAll('\n', '\r\n');
}

/** Every file under `dir`, recursively, absolute; a build output holds no symlink, so one fails the test. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`the build shipped a symlink: ${entry.name}`);
      return entry.isFile();
    })
    .map((entry) => safePath.join(entry.parentPath, entry.name));
}

/** A fresh committed corpus, checked out again under `core.autocrlf=true`: CRLF on disk, LF in git. */
function crlfCorpus(): string {
  const repo = join(context.createTempDir(), 'corpus');
  mkdirSyncReal(join(repo, 'skills/demo'), { recursive: true });
  mkdirSyncReal(join(repo, 'docs'), { recursive: true });
  writeTestFile(join(repo, 'vibe-agent-toolkit.config.yaml'), createSkillsConfigYaml([SKILL]));
  writeTestFile(join(repo, SKILL), SKILL_BODY);
  writeTestFile(join(repo, GUIDE), GUIDE_BODY);
  commitTestFixture(repo);
  runGitOrThrow(['config', 'core.autocrlf', 'true'], { cwd: repo });
  for (const path of [SKILL, GUIDE]) rmSync(join(repo, path));
  runGitOrThrow(['checkout', '--', SKILL, GUIDE], { cwd: repo });
  return repo;
}

describe('a skill built from a CRLF checkout of LF objects', () => {
  beforeAll(() => context.setup());

  afterAll(context.cleanup);

  it('ships the checkout\'s CRLF bytes with the link rewritten in place', async () => {
    const repo = crlfCorpus();
    expect(readFileSync(join(repo, SKILL), 'utf-8'), 'the checkout holds CRLF').toContain('\r\n');
    const result = await executeCli(context.binPath, ['skills', 'build'], {
      cwd: repo,
      env: { [PROJECTION_STORE_ENV]: PROJECTION_STORE_SQLITE, [VAT_CACHE_DIR_ENV]: join(repo, '..', 'cache') },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const shipped = filesUnder(join(repo, 'dist')).filter((path) => path.endsWith('.md'));
    const skill = shipped.find((path) => path.endsWith('/SKILL.md'));
    const guide = shipped.find((path) => path.endsWith('/guide.md'));
    if (skill === undefined || guide === undefined) throw new Error(`the build shipped ${shipped.join(', ')}`);
    for (const path of shipped) expect(readFileSync(path, 'utf-8'), `${path}: CRLF, as the checkout holds it`).toContain('\r\n');

    const text = readFileSync(skill, 'utf-8');
    const link = /See \[the guide\]\(([^)]+)\) for more\.\r\n$/u.exec(text);
    expect(link, `the link and the prose around it are intact:\n${text}`).not.toBeNull();
    const target = link?.[1] ?? '';
    expect(target, 'the link was rewritten').not.toBe('../../docs/guide.md');
    expect(safePath.resolve(skill, '..', target), 'the rewritten link names the bundled guide').toBe(guide);
    const source = crlf(SKILL_BODY);
    expect(text.slice(0, text.indexOf('See [the guide]')), 'everything before the link is the source, untouched').toBe(source.slice(0, source.indexOf('See [the guide]')));
    expect(readFileSync(guide, 'utf-8')).toBe(crlf(GUIDE_BODY));
  });

  it('reads each file it parses and rewrites from disk exactly once in a cold run, and nothing from git', async () => {
    const run = await runWithWorkCounters(context, crlfCorpus(), ['skills', 'build'], {
      cacheDir: context.createTempDir(),
      tmpDir: null,
      storeOff: false,
      probeRoot: null,
      cores: null,
    });
    const counts = soleProcessCounters(run, ['content.gitRead', 'content.read']);
    // Five reads, one per file. The three inputs, each read once by the build's one run, every
    // lane after the first served that read:
    //   1. skills/demo/SKILL.md: discovery names the skill from it, and the source validation,
    //      the packager's parse and the link rewrite reuse that read.
    //   2. docs/guide.md: the link walk reaches it, and the bundle's copy is that read.
    //   3. vibe-agent-toolkit.config.yaml: the run's config.
    // And the two OUTPUT files, each read once by the post-build check of the staged bundle:
    //   4. the staged SKILL.md.
    //   5. the staged guide.md.
    expect(counts, 'nothing read from git; each input read once, each staged output once').toEqual({ 'content.read': 5, 'content.gitRead': 0 });
  });

  it('packages a skill opening each input once at the fs boundary', async () => {
    const repo = crlfCorpus();
    // Outside the probed tree, so the probe counts the inputs alone, not the package it writes.
    const out = join(context.createTempDir(), 'package');
    const run = await runWithWorkCounters(context, repo, ['skills', 'package', SKILL, '-o', out], {
      cacheDir: context.createTempDir(),
      tmpDir: null,
      storeOff: false,
      probeRoot: repo,
      cores: null,
    });
    expect(run.result.status, `${run.result.stdout}\n${run.result.stderr}`).toBe(0);
    // The probe counts every open of a file for reading, a raw `readFileSync` included, which the
    // content counters cannot see. One each: the argument check names the SKILL.md without reading
    // it, and the gate and the packager are served the run's one read of each file.
    const reads = probedReads(run.probeDir ?? '').reads;
    expect({ skill: reads.get(SKILL), guide: reads.get(GUIDE) }, 'each input opened once').toEqual({ skill: 1, guide: 1 });
  });
});
