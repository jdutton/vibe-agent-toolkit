/**
 * A file with no frontmatter is not a skill, and the packaging validator must
 * say so rather than pass it.
 *
 * ## The defect
 *
 * `validateSkillForPackaging` guarded its frontmatter checks with
 * `if (parseResult.frontmatter)`, so a SKILL.md whose frontmatter block was
 * missing — or a plain `# Readme` that a `skills.include` glob drifted onto —
 * ran NO frontmatter check at all and came back `status: success` under the
 * H1 (or filename) as its name. `validateSkill` in skill-validator.ts already
 * refused the same bytes with `SKILL_MISSING_FRONTMATTER`; the packaging lane,
 * which is what `vat skills validate` / `vat validate` / `vat verify` run,
 * did not. A CI gate over a project whose SKILL.md files lost their
 * frontmatter was green.
 *
 * ## The mechanism is shared, not new
 *
 * `SKILL_MISSING_FRONTMATTER` is a `NonOverridableCode`: it has no
 * `CODE_REGISTRY` entry, so the framework's `finalize()` passes it through
 * untouched and `ValidationConfigSchema` refuses it as a `severity` key. The
 * rows below hand the framework a config that names it anyway, to pin that a
 * config cannot turn this refusal off.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { PackagingValidationResult } from '../../src/validators/packaging-validator.js';
import { activeErrorsOf, validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import { createTransitiveSkillStructure, setupTempDir } from '../test-helpers.js';

const { getTempDir } = setupTempDir('packaging-validator-missing-frontmatter-');

const MISSING_FRONTMATTER = 'SKILL_MISSING_FRONTMATTER';
const MISSING_NAME = 'SKILL_MISSING_NAME';

/** A file no `parseFrontmatter` would accept: no `---` block at all. */
const PLAIN_README = '# Readme\n\nNot a skill.\n';

/** A frontmatter block that parses but declares no `name`. */
const FRONTMATTER_WITHOUT_NAME =
  '---\ndescription: A fixture whose frontmatter forgot the name field entirely, on purpose.\n---\n\n# Beta\n\nBody.\n';

/**
 * A config that tries to switch the code off. Non-overridable codes are refused
 * by the config SCHEMA, so this can only be built past the type — which is the
 * point: even a config that reached the framework by some other route cannot
 * demote the finding.
 */
const CONFIG_TRYING_TO_IGNORE = (code: string) => ({
  validation: { severity: { [code]: 'ignore' } },
}) as unknown as Parameters<typeof validateSkillForPackaging>[1];

/** Write `body` as SKILL.md in a fresh temp dir and validate it with `config`. */
async function validateBody(
  body: string,
  config?: Parameters<typeof validateSkillForPackaging>[1],
): Promise<PackagingValidationResult> {
  const { skillPath } = createTransitiveSkillStructure(getTempDir(), {}, body);
  return validateSkillForPackaging(skillPath, config);
}

/** The one error of `code`, asserted present, at `error`, anchored to SKILL.md. */
function expectRefusal(result: PackagingValidationResult, code: string): ValidationIssue | undefined {
  expect(result.status).toBe('error');
  const found = activeErrorsOf(result).filter((issue) => issue.code === code);
  expect(found).toHaveLength(1);
  const [issue] = found;
  expect(issue?.severity).toBe('error');
  expect(issue?.location).toBe('SKILL.md');
  return issue;
}

/** A green result that emits neither frontmatter code. */
function expectGreenWithoutFrontmatterCodes(result: Awaited<ReturnType<typeof validateBody>>): void {
  expect(result.status).toBe('success');
  const codes = activeErrorsOf(result).map((i) => i.code);
  expect(codes).not.toContain(MISSING_FRONTMATTER);
  expect(codes).not.toContain(MISSING_NAME);
}

describe('validateSkillForPackaging refuses a file with no frontmatter', () => {
  it('a plain markdown file with no frontmatter block is SKILL_MISSING_FRONTMATTER at error', async () => {
    const result = await validateBody(PLAIN_README);

    const issue = expectRefusal(result, MISSING_FRONTMATTER);
    // The refusal names the reason, not just the code — an operator reading
    // the stderr line under the row must not have to open the file to learn why.
    expect(issue?.message.toLowerCase()).toContain('frontmatter');
    expect(issue?.line).toBe(1);
  });

  it('frontmatter that is present but unparseable is the same refusal, carrying the parser error', async () => {
    const result = await validateBody('---\nname: [unclosed\n---\n\n# Broken\n');

    const issue = expectRefusal(result, MISSING_FRONTMATTER);
    // Not the generic "no frontmatter" wording — the YAML parser's own message,
    // so a fence typo is distinguishable from an absent block.
    expect(issue?.message.toLowerCase()).not.toContain('no yaml frontmatter');
  });

  it('a config naming the code as ignore cannot demote it — it is non-overridable', async () => {
    const result = await validateBody(PLAIN_README, CONFIG_TRYING_TO_IGNORE(MISSING_FRONTMATTER));

    expectRefusal(result, MISSING_FRONTMATTER);
  });

  it('frontmatter that is present but declares no name is NOT this refusal — name is optional per agentskills.io', async () => {
    const result = await validateBody(FRONTMATTER_WITHOUT_NAME);

    // `AgentSkillFrontmatterSchema` marks `name` optional ("defaults to parent
    // directory name if omitted"), so the frontmatter checks run and find
    // nothing to refuse. Pinned so the new guard cannot widen into "no name
    // means no frontmatter". (`SKILL_MISSING_NAME` exists only on the stricter
    // VAT-generated schema, which this lane does not apply.)
    expectGreenWithoutFrontmatterCodes(result);
  });

  it('a skill with a well-formed frontmatter block emits neither code — the refusal is off the green path', async () => {
    const result = await validateBody(
      '---\nname: gamma\ndescription: A fixture skill with a complete, well-formed frontmatter block.\n---\n\n# gamma\n\nBody.\n',
    );

    expectGreenWithoutFrontmatterCodes(result);
  });
});
