/**
 * A SKILL.md nested deep enough that the parse worker refuses it declares
 * nothing this run could read — so no lane may NAME it. Discovery, the plugin
 * build and `vat verify` carry the refusal instead of a fallback name;
 * `vat ard emit` and `vat claude plugin install` refuse the run, naming the
 * file and the limit; `vat skills package` reports a refused package unnamed.
 *
 * 50,000 levels: 5,000 overflows `yaml` on a plain `node` main thread but not
 * inside a vitest worker, whose stack is larger.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runArdEmit } from '../../src/commands/ard/emit.js';
import { createPluginCommand } from '../../src/commands/claude/plugin/index.js';
import { discoverSkillsFromConfig, readPluginLocalSkillName, skillDocumentOrRefused } from '../../src/commands/skills/skill-discovery.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { CONFIG_YAML_WITH_ARD, projectWith, PUBLISHED_SKILL } from '../ard-test-helpers.js';
import { makeCaseRoot, runVerb, type CaseRoot, type VerbCase } from '../fault-matrix/drive.js';

const DEPTH = 50_000;
const DEEP_SKILL = `---\nname: deep\nnested: ${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}\n---\n# Deep\n`;

/** The refusal sentence names the limit that stopped the parse. */
const NAMES_THE_LIMIT = /parse was stopped at its \w+ limit/;

describe('a SKILL.md the parse worker refuses', () => {
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'skill-name-overflow-'));
    writeFileSync(safePath.join(skillDir, 'SKILL.md'), DEEP_SKILL, 'utf-8');
  });

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('is read as a refusal, never named by its directory', async () => {
    await expect(readPluginLocalSkillName(skillDir)).resolves.toMatchObject({
      kind: 'refused',
      refused: { code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' },
    });
  });

  it('is carried by config discovery as refused, not as a skill under any name', async () => {
    const discovery = await discoverSkillsFromConfig({ include: ['**/SKILL.md'] }, skillDir, 'refuse');
    expect(discovery.skills).toEqual([]);
    expect(discovery.parseRefused).toMatchObject([
      { filePath: safePath.join(skillDir, 'SKILL.md'), code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' },
    ]);
  });

  it('reads as refused, so a refused package report still publishes', async () => {
    await expect(skillDocumentOrRefused(safePath.join(skillDir, 'SKILL.md'))).resolves.toMatchObject({ kind: 'refused' });
  });
});

describe('vat ard emit over a project whose SKILL.md the parse worker refuses', () => {
  const work = tempDirTracker('vat-ard-refused-');
  afterEach(() => work.cleanupAll());

  it('refuses the run, naming the file and the limit, and writes no manifest', async () => {
    const root = projectWith(work.create(), 'refused', CONFIG_YAML_WITH_ARD);
    const dir = mkdirSyncReal(safePath.join(root, 'skills', PUBLISHED_SKILL), { recursive: true });
    writeFileSync(safePath.join(dir, 'SKILL.md'), DEEP_SKILL, 'utf-8');

    const run = runArdEmit({ projectRoot: root });

    const error: unknown = await run.then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toContain(`skills/${PUBLISHED_SKILL}/SKILL.md`);
    expect((error as Error).message).toMatch(NAMES_THE_LIMIT);
    expect(existsSync(safePath.join(root, '.well-known', 'ard.json'))).toBe(false);
  });
});

describe('vat claude plugin install of a skill directory whose SKILL.md the parse worker refuses', () => {
  const scratch = tempDirTracker('vat-plugin-install-refused-');
  afterEach(() => {
    vi.unstubAllEnvs();
    scratch.cleanupAll();
  });

  const SOURCE_DIR = 'leaf-dir-name';
  const source = (r: CaseRoot): string => safePath.join(r.root, 'input', SOURCE_DIR);
  const refusedSkillCase: VerbCase = {
    id: 'plugin/install/dir/refused-skill-md',
    group: () => createPluginCommand(),
    argv: (r) => ['install', source(r)],
    fixture: (r) => {
      mkdirSyncReal(source(r), { recursive: true });
      writeFileSync(safePath.join(source(r), 'SKILL.md'), DEEP_SKILL, 'utf-8');
    },
    watched: (r) => [safePath.join(r.home, '.claude')],
    units: () => [],
    sources: (r) => [source(r)],
  };

  it('refuses INPUT_UNREADABLE naming the limit, and installs nothing under the directory name', async () => {
    const r = makeCaseRoot(scratch.create());
    refusedSkillCase.fixture(r);

    const outcome = await runVerb(refusedSkillCase, r);

    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'INPUT_UNREADABLE' });
    expect(outcome.message).toMatch(NAMES_THE_LIMIT);
    expect(outcome.message).toContain('SKILL.md');
    expect(existsSync(safePath.join(r.home, '.claude', 'skills', SOURCE_DIR))).toBe(false);
  });
});
