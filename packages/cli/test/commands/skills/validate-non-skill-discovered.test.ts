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

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { type buildValidateSummary, runSkillsValidatePhase } from '../../../src/commands/skills/validate.js';
import { resetSkillDiscoveryCache } from '../../../src/skill-resolution/packaging-config.js';

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

/** The phase's document, typed by what the builder publishes. */
type Summary = ReturnType<typeof buildValidateSummary>;

/** Verbose rows carry the whole result; this is the slice these rows read. */
interface VerboseRow {
  skillName: string;
  status: string;
  allErrors: Array<{ code: string; location?: string; severity: string }>;
}

const includeOnly = (glob: string): string => `version: 1\nskills:\n  include:\n    - "${glob}"\n`;

describe('vat skills validate refuses a discovered file that is not a skill', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  it('a glob that matches a plain markdown file is not success — the file fails, by path, exit 1', async () => {
    const root = writeProject(includeOnly(README_PATH), ALPHA_SKILL);

    const outcome = await runSkillsValidatePhase(root, { verbose: true });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.failed).toBeUndefined();
    const document = outcome.document as Summary;
    expect(document.status).toBe('error');
    // The glob matched one file, so one was checked — the refusal is on the
    // file, not a zero-denominator run-integrity refusal.
    expect(document.skillsValidated).toBe(1);
    expect(document.runIssues).toEqual([]);
    const [row] = document.results as VerboseRow[];
    expect(row?.status).toBe('error');
    const refusal = row?.allErrors.find((issue) => issue.code === MISSING_FRONTMATTER);
    expect(refusal?.severity).toBe('error');
    // Names the file the glob matched, relative to the project root.
    expect(refusal?.location).toBe(README_PATH);
  });

  it('a SKILL.md that lost its frontmatter fails the same way, beside a real skill that passes', async () => {
    const root = writeProject(includeOnly(SKILLS_GLOB), '# Beta\n\nBody with no frontmatter.\n');

    const outcome = await runSkillsValidatePhase(root, { verbose: true });

    expect(outcome.exitCode).toBe(1);
    const document = outcome.document as Summary;
    expect(document.status).toBe('error');
    expect(document.skillsValidated).toBe(2);
    const rows = document.results as VerboseRow[];
    const byLocation = new Map(
      rows.map((row) => [row.allErrors.find((i) => i.code === MISSING_FRONTMATTER)?.location, row.status]),
    );
    // Exactly one row refused, and it is beta's file; alpha has no such finding.
    expect(byLocation.get(BETA_PATH)).toBe('error');
    expect(rows.filter((row) => row.status === 'error')).toHaveLength(1);
    expect(rows.find((row) => row.skillName === 'alpha')?.status).toBe('success');
  });

  it('two real skills stay green — the refusal is off the populated, well-formed path', async () => {
    const root = writeProject(includeOnly(SKILLS_GLOB), ALPHA_SKILL.replaceAll('alpha', 'beta'));

    const outcome = await runSkillsValidatePhase(root, {});

    expect(outcome.exitCode).toBe(0);
    const document = outcome.document as Summary;
    expect(document.status).toBe('success');
    expect(document.skillsValidated).toBe(2);
  });
});
