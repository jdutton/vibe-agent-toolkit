/**
 * `vat skills validate` must not count a file with no frontmatter as a skill it
 * validated.
 *
 * ## The defect
 *
 * The zero-denominator refusal (`withRunIntegrity` over `results.length`)
 * counts every file the `skills.include` globs matched. Discovery names such a
 * file by its frontmatter `name`, falling back to its H1 and then its filename,
 * so `include: ["skills/README.md"]` over a plain `# Readme` produced
 * `🔍 Found 1 skill(s)`, `✅ Readme`, `status: success`, `skillsValidated: 1`,
 * exit 0 — while `vat audit skills/README.md` said `UNKNOWN_FORMAT`. A SKILL.md
 * with NO frontmatter block was likewise `✅`, because the packaging validator
 * ran its frontmatter checks only `if (parseResult.frontmatter)`. A CI gate over
 * a project whose SKILL.md files lost their frontmatter, or whose glob drifted
 * onto docs, was green.
 *
 * ## The fix is in the validator, and this file pins the command
 *
 * The file the glob matched is still discovered — the glob named it, so the
 * report names it — but it now FAILS: the packaging validator emits the same
 * non-overridable `SKILL_MISSING_FRONTMATTER` that `validateSkill` always did,
 * anchored to the file's project-relative path. These rows run
 * `runSkillsValidatePhase` on a project on disk because that is the entry point
 * `vat validate` and `vat verify` consume, so the fold is exercised too.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resetSkillDiscoveryCache } from '../../../src/skill-resolution/packaging-config.js';

import { publishedSkillsValidate } from './skills-validate-document.js';

const MISSING_FRONTMATTER = 'SKILL_MISSING_FRONTMATTER';

/** A real skill, so a green row is distinguishable from a refused one in the same run. */
const ALPHA_SKILL =
  '---\nname: alpha\ndescription: Fixture skill alpha with a complete frontmatter block for this probe.\n---\n\n# alpha\n\nBody.\n';

/** The bytes `vat audit` calls UNKNOWN_FORMAT: an H1 and prose, no `---` block. */
const PLAIN_README = '# Readme\n\nNot a skill.\n';

/** Every project writes its config here, and the scope guard reads it from here. */
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';
const SKILLS_GLOB = 'skills/*/SKILL.md';
/** The plain markdown file, by the project-relative path the refusal must name. */
const README_PATH = 'skills/README.md';
const BETA_PATH = 'skills/beta/SKILL.md';

/** Temp roots this file created, removed once at the end. */
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A project with `skills/alpha/SKILL.md` (real), `skills/README.md` (plain
 * markdown), `skills/beta/SKILL.md` with the given body, and the given config.
 */
function writeProject(configBody: string, betaBody: string): string {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'skills-validate-non-skill-')));
  tempRoots.push(root);
  const write = (rel: string, body: string): void => {
    const abs = safePath.join(root, rel);
    mkdirSyncReal(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  write('skills/alpha/SKILL.md', ALPHA_SKILL);
  write(BETA_PATH, betaBody);
  write(README_PATH, PLAIN_README);
  write(CONFIG_FILE, configBody);
  return root;
}


const includeOnly = (glob: string): string => `skills:\n  include:\n    - "${glob}"\n`;

describe('vat skills validate refuses a discovered file that is not a skill', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  it('a glob that matches a plain markdown file is not success — the file fails, by path, exit 1', async () => {
    const root = writeProject(includeOnly(README_PATH), ALPHA_SKILL);

    const { exitCode, document } = await publishedSkillsValidate(root);

    expect(exitCode).toBe(1);
    expect(document.status).toBe('findings');
    // The glob matched one file, so one was checked — the refusal is on the
    // file, not a zero-denominator run-integrity refusal.
    expect(document.examined).toBe(1);
    const [row] = document.data.skills;
    expect(row?.status).toBe('findings');
    expect(row?.summary.errors).toBe(1);
    const refusal = document.findings.find((issue) => issue.code === MISSING_FRONTMATTER);
    expect(refusal?.severity).toBe('error');
    // Names the file the glob matched, relative to the project root.
    expect(refusal?.location).toBe(README_PATH);
  });

  it('a SKILL.md that lost its frontmatter fails the same way, beside a real skill that passes', async () => {
    const root = writeProject(includeOnly(SKILLS_GLOB), '# Beta\n\nBody with no frontmatter.\n');

    const { exitCode, document } = await publishedSkillsValidate(root);

    expect(exitCode).toBe(1);
    expect(document.status).toBe('findings');
    expect(document.examined).toBe(2);
    // Exactly one finding refused a file, and it is beta's; alpha's row is clean.
    expect(document.findings.filter((i) => i.code === MISSING_FRONTMATTER).map((i) => i.location)).toEqual([BETA_PATH]);
    expect(document.data.skills.filter((row) => row.summary.errors > 0)).toHaveLength(1);
    expect(document.data.skills.find((row) => row.name === 'alpha')?.summary.errors).toBe(0);
  });

  it('two real skills stay green — the refusal is off the populated, well-formed path', async () => {
    const root = writeProject(includeOnly(SKILLS_GLOB), ALPHA_SKILL.replaceAll('alpha', 'beta'));

    const { exitCode, document } = await publishedSkillsValidate(root);

    expect(exitCode).toBe(0);
    expect(document.summary.errors).toBe(0);
    expect(document.examined).toBe(2);
  });
});
