/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/**
 * Unit tests for the settings compatibility checker's tool-blocking verdict.
 *
 * 🔑 The single property under test: the checker's answer about a tool is the
 * MATCHER's answer about that tool. The checker is the matcher's only production
 * caller, and the matcher carries an explicit written ruling — a rule like
 * `Write(./secrets/**)` blocks nothing, because Claude Code accepts path rules
 * for `Write`/`Glob`/`NotebookRead`/`NotebookEdit` and never consults them. A
 * checker that answers that question itself, by string-prefixing the rule, can
 * and did contradict the ruling its own dependency publishes.
 *
 * ⚠️ It did so TWICE, in two different spellings, which is why the second suite
 * in this file is a table over spellings rather than a case. The first repair
 * fixed bare `Write` versus `Write(./out/**)` and left every PARTIAL wildcard —
 * `Bash(git:*)`, `Read(./**)` — going to the matcher as a literal command or
 * filename. See {@link DECLARATIONS}.
 */

import * as fs from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { matchesDenyRule, ruleConstrainsDeclaration } from '../src/settings/permission-matcher.js';
import { checkSettingsCompatibility } from '../src/settings/settings-compat-checker.js';
import type { EffectiveSettings } from '../src/settings/settings-merger.js';

const SETTINGS_FILE = 'managed-settings.json';

function settingsDenying(rule: string): EffectiveSettings {
  return {
    permissions: {
      allow: [],
      ask: [],
      deny: [{ rule, provenance: { level: 'managed', file: SETTINGS_FILE } }],
    },
  };
}

const SECRETS_KEY = './secrets/key';
const OUT_X = './out/x';
const RM_RF_ROOT = 'rm -rf /';
const DOMAIN_EVIL = 'domain:evil.com';
const READ_SECRETS = 'Read(./secrets/**)';
const BASH_RM_STAR = 'Bash(rm *)';
const MCP_TOOL = 'mcp__srv__tool';
const WRITE_SECRETS = 'Write(./secrets/**)';
const GIT_PUSH_PREFIX = 'Bash(git push:*)';
const GIT_PREFIX = 'Bash(git:*)';
const READ_ALL = 'Read(./**)';

/**
 * The concrete tool inputs the unrestricted spelling stands for.
 *
 * A skill that declares a tool BARE is declaring it unrestricted, so the honest
 * reading of "is this tool blocked?" is "does the rule block any input to it?".
 * The `finds a witness` test below proves this set reaches every rule in
 * {@link RULES} that blocks anything, so the disjunction it feeds is a real
 * assertion rather than a vacuous one.
 *
 * The empty string is deliberately a member: it is exactly what the checker
 * used to hand the path lane for a bare spelling, and node-ignore threw on it.
 */
const PROBE_INPUTS = ['', OUT_X, SECRETS_KEY, RM_RF_ROOT, 'ls', DOMAIN_EVIL, 'nested/file.txt'];

/** The tool inputs each parenthesised spelling is tested with. */
const SPELLINGS = [OUT_X, SECRETS_KEY, RM_RF_ROOT, DOMAIN_EVIL];

/**
 * (tool, rule, constrains) rows spanning every branch the matcher
 * distinguishes: the two consulted path tools, each unconsulted one, Bash,
 * WebFetch, an MCP-shaped tool whose content is never interpreted, bare rules,
 * a wildcard content, and a tool-name glob.
 *
 * `constrains` is the DECLARED truth — "can this rule stop this tool doing
 * anything at all?" — written down here rather than derived from the code under
 * test. Both the checker and the matcher are held to it below.
 */
const RULES: ReadonlyArray<readonly [tool: string, rule: string, constrains: boolean]> = [
  ['Read', READ_SECRETS, true],
  ['Edit', 'Edit(./secrets/**)', true],
  // Accepted by Claude Code and never consulted — so these block nothing.
  ['Write', WRITE_SECRETS, false],
  ['Glob', 'Glob(./secrets/**)', false],
  ['NotebookRead', 'NotebookRead(./secrets/**)', false],
  ['NotebookEdit', 'NotebookEdit(./secrets/**)', false],
  ['Write', 'Write(*)', false],
  // A BARE rule names the tool itself, which is consulted for every tool.
  ['Write', 'Write', true],
  ['Bash', BASH_RM_STAR, true],
  ['Bash', 'Bash', true],
  ['WebFetch', 'WebFetch(domain:evil.com)', true],
  // An MCP tool's content is not interpreted, so only a `*` covers a call.
  [MCP_TOOL, `${MCP_TOOL}(foo)`, false],
  [MCP_TOOL, `${MCP_TOOL}(*)`, true],
  ['Write', '*', true],
];

const UNCONSULTED_PATH_TOOLS = ['Write', 'Glob', 'NotebookRead', 'NotebookEdit'];

/** A plugin holding one skill whose `allowed-tools:` this suite rewrites. */
interface SkillFixture {
  pluginDir: string;
  skillFile: string;
}

/**
 * Creates one such plugin under a temp directory named for the calling suite,
 * and registers its teardown. The directory does not exist until `beforeAll`
 * has run, so the fixture is reached through the returned getter rather than
 * captured at describe time.
 */
function setupSkillFixture(prefix: string): { getFixture: () => SkillFixture } {
  let created: SkillFixture | undefined;

  beforeAll(async () => {
    const pluginDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), prefix));
    const skillDir = safePath.join(pluginDir, 'skills', 's1');
    await fs.mkdir(skillDir, { recursive: true });
    created = { pluginDir, skillFile: safePath.join(skillDir, 'SKILL.md') };
  });

  afterAll(async () => {
    if (created !== undefined) {
      await fs.rm(created.pluginDir, { recursive: true, force: true });
    }
  });

  return {
    getFixture: (): SkillFixture => {
      if (created === undefined) {
        throw new Error('skill fixture read before beforeAll created it');
      }
      return created;
    },
  };
}

/** The tool spellings the checker reports as blocked by `rule`. */
async function blockedTools(
  fixture: SkillFixture,
  tools: string[],
  rule: string
): Promise<string[]> {
  await fs.writeFile(
    fixture.skillFile,
    `---\nname: s1\nallowed-tools: [${tools.join(', ')}]\n---\n\nbody\n`,
    'utf-8'
  );
  const conflicts = await checkSettingsCompatibility(fixture.pluginDir, settingsDenying(rule));
  return tools.filter((tool) =>
    conflicts.some((conflict) => conflict.detail.startsWith(`Tool "${tool}" `))
  );
}

describe('settings compatibility checker — tool blocking', () => {
  const { getFixture } = setupSkillFixture('vat-compat-checker-');

  const matcherBlocksSomeInput = (tool: string, rule: string): boolean =>
    PROBE_INPUTS.some((input) => matchesDenyRule(tool, input, rule, getFixture().pluginDir));

  // 🚩 Without this the bare-spelling assertion below could hold because the
  // probe set never reaches the rule at all, which is the vacuous shape this
  // repo keeps finding. It is also the ruling itself, stated over the matcher:
  // NO input is blocked by an unconsulted tool's path rule.
  it('finds a witness input for exactly the rules that constrain their tool', () => {
    for (const [tool, rule, constrains] of RULES) {
      expect(matcherBlocksSomeInput(tool, rule), `${tool} vs ${rule}`).toBe(constrains);
    }
  });

  it('gives the matcher answer for a parenthesised spelling', async () => {
    for (const [tool, rule] of RULES) {
      for (const input of SPELLINGS) {
        const spelling = `${tool}(${input})`;
        const blocked = await blockedTools(getFixture(), [spelling], rule);
        expect(blocked.length > 0, `${spelling} vs ${rule}`).toBe(
          matchesDenyRule(tool, input, rule, getFixture().pluginDir)
        );
      }
    }
  });

  it('gives the matcher answer for the bare spelling', async () => {
    for (const [tool, rule, constrains] of RULES) {
      const blocked = await blockedTools(getFixture(), [tool], rule);
      // Held to the declared truth AND to the matcher's own probe answer, so a
      // drift in either one fails here rather than the two agreeing quietly.
      expect(blocked.length > 0, `bare ${tool} vs ${rule}`).toBe(constrains);
      expect(blocked.length > 0, `bare ${tool} vs ${rule}`).toBe(
        matcherBlocksSomeInput(tool, rule)
      );
    }
  });

  // The reproduction from the review, stated as the contradiction it is: one
  // deny rule must not answer differently for `Write` and `Write(./out/**)`.
  it('does not contradict itself between the two spellings of an unconsulted tool', async () => {
    for (const tool of UNCONSULTED_PATH_TOOLS) {
      const rule = `${tool}(./secrets/**)`;
      const blocked = await blockedTools(
        getFixture(),
        [tool, `${tool}(./out/**)`, `${tool}(${SECRETS_KEY})`],
        rule
      );
      expect(blocked, `${tool} vs ${rule}`).toEqual([]);
    }
  });

  // The control: the checker still reports what it should. A bare rule denies
  // the whole tool, and that reaches every spelling of it.
  it('still reports a bare deny rule against every spelling', async () => {
    const tools = ['Write', 'Write(./out/**)'];
    expect(await blockedTools(getFixture(), tools, 'Write')).toEqual(tools);
  });

  // The other control: the consulted lanes are untouched by the fix, including
  // the bare spelling that used to CRASH the path lane with an empty path.
  it('still reports a consulted path rule and a Bash rule', async () => {
    expect(await blockedTools(getFixture(), ['Read', `Read(${SECRETS_KEY})`], READ_SECRETS)).toEqual([
      'Read',
      `Read(${SECRETS_KEY})`,
    ]);
    expect(await blockedTools(getFixture(), [`Read(${OUT_X})`], READ_SECRETS)).toEqual([]);
    expect(await blockedTools(getFixture(), ['Bash', `Bash(${RM_RF_ROOT})`], BASH_RM_STAR)).toEqual([
      'Bash',
      `Bash(${RM_RF_ROOT})`,
    ]);
    expect(await blockedTools(getFixture(), ['Bash(ls)'], BASH_RM_STAR)).toEqual([]);
  });
});

// ============================================================================
// A wildcard-bearing declaration is a PATTERN, not a command
// ============================================================================

/**
 * (declaration, deny rule, conflicts) rows, where `conflicts` is the DECLARED
 * truth: *"can this org deny rule stop this skill doing something its
 * `allowed-tools:` entry says it will do?"*
 *
 * 🚩 Every `Bash(…:*)` and `Read(…/**)` row here answered `false` before this
 * table existed, because the checker pulled the parenthesised text out and
 * handed it to the matcher as a CONCRETE command or path. Only the two fully
 * unrestricted spellings — bare `Bash` and `Bash(*)` — took the pattern route,
 * so `Bash` vs `Bash(git push:*)` reported a conflict and `Bash(git:*)` vs the
 * same rule reported none. One deny rule, two answers, decided by how much of
 * its own scope the SKILL.md bothered to write down — and the direction is
 * UNDER-report, which the checker's own docstring calls the unsafe one.
 *
 * ⚠️ `Bash(git:*)`, `Bash(npm run:*)` and `Read(./**)` are not exotic: the `:*`
 * prefix form is the spelling Claude Code's own documentation uses, so the
 * spellings people actually write were the ones taking the broken route.
 *
 * The truths are written HERE rather than derived from either implementation,
 * and both the checker and the matcher primitive it calls are held to them.
 */
const DECLARATIONS: ReadonlyArray<readonly [decl: string, rule: string, conflicts: boolean]> = [
  // A rule that blocks SOME git commands, against declarations of varying width.
  ['Bash', GIT_PUSH_PREFIX, true],
  ['Bash(*)', GIT_PUSH_PREFIX, true],
  // 🚩 The reviewed row: the skill claims every git command, the org blocks a
  // subset of them, and that subset is inside the claim.
  [GIT_PREFIX, GIT_PUSH_PREFIX, true],
  ['Bash(git *)', GIT_PUSH_PREFIX, true],
  [GIT_PUSH_PREFIX, GIT_PUSH_PREFIX, true],
  ['Bash(git push)', GIT_PUSH_PREFIX, true],
  ['Bash(git push origin main)', GIT_PUSH_PREFIX, true],
  // …and the controls that keep the row above from being "any wildcard matches".
  ['Bash(npm run:*)', GIT_PUSH_PREFIX, false],
  ['Bash(git status)', GIT_PUSH_PREFIX, false],
  [READ_ALL, GIT_PUSH_PREFIX, false],

  // The same, the other way round: the rule is the wide one.
  ['Bash(rm:*)', BASH_RM_STAR, true],
  ['Bash(rm -rf /)', BASH_RM_STAR, true],
  [GIT_PREFIX, BASH_RM_STAR, false],
  ['Bash(ls)', BASH_RM_STAR, false],

  // The path lane has the identical defect and the identical fix: `./**` is a
  // pattern that contains `./secrets/**`, not a file named `./**`.
  [READ_ALL, READ_SECRETS, true],
  ['Read(./secrets/**)', READ_SECRETS, true],
  [`Read(${SECRETS_KEY})`, READ_SECRETS, true],
  ['Read(./out/**)', READ_SECRETS, false],

  // ⛔ And the taxonomy still decides first: a path rule for an UNCONSULTED tool
  // blocks nothing, however wide either side is spelled. Widening the compared
  // shape must not widen the set of tools that have a path lane at all.
  ['Write(./**)', WRITE_SECRETS, false],
  [WRITE_SECRETS, WRITE_SECRETS, false],

  // A bare rule names the tool and nothing else, so it reaches every spelling.
  [GIT_PREFIX, 'Bash', true],
  ['Read(./out/**)', 'Read', true],
  // …and a rule for a DIFFERENT tool reaches none of them.
  [READ_ALL, 'Write', false],
];

describe('settings compatibility checker — a wildcarded declaration', () => {
  const { getFixture } = setupSkillFixture('vat-compat-pattern-');

  it('is reported per the declared truth for every spelling', async () => {
    for (const [decl, rule, conflicts] of DECLARATIONS) {
      const blocked = await blockedTools(getFixture(), [decl], rule);
      expect(blocked.length > 0, `${decl} vs ${rule}`).toBe(conflicts);
    }
  });

  // The checker must not be re-deriving this. Same table, asked of the matcher
  // primitive directly — so a checker that answered correctly by its own means
  // would still leave the module that OWNS the taxonomy wrong.
  it('is the matcher primitive answer, not the checker own', () => {
    for (const [decl, rule, conflicts] of DECLARATIONS) {
      expect(
        ruleConstrainsDeclaration(decl, rule, 'deny', getFixture().pluginDir),
        `${decl} vs ${rule}`,
      ).toBe(conflicts);
    }
  });

  // 🚩 The contradiction the review measured, stated as the invariant it breaks:
  // widening what a skill declares can never make a conflict disappear. Every
  // narrowing of `Bash` below still wants `git push`, which the rule blocks.
  it('never answers "no conflict" for a narrowing of a spelling it answers "conflict" for', async () => {
    const rule = GIT_PUSH_PREFIX;
    const narrowings = ['Bash', 'Bash(*)', GIT_PREFIX, 'Bash(git *)', GIT_PUSH_PREFIX];
    expect(await blockedTools(getFixture(), narrowings, rule)).toEqual(narrowings);
  });
});
