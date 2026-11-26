/**
 * A skill built from a `core.autocrlf=true` checkout ships git's LF bytes, links rewritten at
 * the right spans.
 *
 * A store-on run keys a git member by its object, and the packager reads the bytes that key
 * names: LF, as git holds them, while the checkout holds CRLF. The link spans were parsed from
 * those same bytes, so splicing them into the LF text lands each rewrite on its link. Splicing
 * them into the CRLF checkout instead would land one byte early per line ending before the link,
 * cutting into the prose around it.
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';

import { mkdirSyncReal, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_SQLITE } from '../../src/utils/projection-store.js';
import { createSkillMarkdown, createSkillsConfigYaml, createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-skills-autocrlf-', import.meta.url);

const SKILL = 'skills/demo/SKILL.md';
const GUIDE = 'docs/guide.md';

/** Lines before the link, so a CRLF offset would move its span by several bytes. */
const SKILL_BODY = `${createSkillMarkdown('demo')}\nOne line.\nTwo lines.\nThree lines.\n\nSee [the guide](../../docs/guide.md) for more.\n`;
const GUIDE_BODY = '# Guide\n\nThe guide, bundled with the skill.\n';

/** Every file under `dir`, recursively, absolute; a build output holds no symlink, so one fails the test. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`the build shipped a symlink: ${entry.name}`);
      return entry.isFile();
    })
    .map((entry) => safePath.join(entry.parentPath, entry.name));
}

describe('a skill built from a CRLF checkout of LF objects', () => {
  let repo: string;

  beforeAll(() => {
    context.setup();
    repo = join(context.createTempDir(), 'corpus');
    mkdirSyncReal(join(repo, 'skills/demo'), { recursive: true });
    mkdirSyncReal(join(repo, 'docs'), { recursive: true });
    writeTestFile(join(repo, 'vibe-agent-toolkit.config.yaml'), createSkillsConfigYaml([SKILL]));
    writeTestFile(join(repo, SKILL), SKILL_BODY);
    writeTestFile(join(repo, GUIDE), GUIDE_BODY);
    commitTestFixture(repo);
    runGitOrThrow(['config', 'core.autocrlf', 'true'], { cwd: repo });
    for (const path of [SKILL, GUIDE]) rmSync(join(repo, path));
    runGitOrThrow(['checkout', '--', SKILL, GUIDE], { cwd: repo });
  });

  afterAll(context.cleanup);

  it('ships LF bytes with the link rewritten in place', async () => {
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
    for (const path of shipped) expect(readFileSync(path, 'utf-8'), `${path}: LF, as git holds it`).not.toContain('\r');

    const text = readFileSync(skill, 'utf-8');
    const link = /See \[the guide\]\(([^)]+)\) for more\.\n$/u.exec(text);
    expect(link, `the link and the prose around it are intact:\n${text}`).not.toBeNull();
    const target = link?.[1] ?? '';
    expect(target, 'the link was rewritten').not.toBe('../../docs/guide.md');
    expect(safePath.resolve(skill, '..', target), 'the rewritten link names the bundled guide').toBe(guide);
    expect(text.slice(0, text.indexOf('See [the guide]')), 'everything before the link is the source, untouched').toBe(SKILL_BODY.slice(0, SKILL_BODY.indexOf('See [the guide]')));
    expect(readFileSync(guide, 'utf-8')).toBe(GUIDE_BODY);
  });
});
