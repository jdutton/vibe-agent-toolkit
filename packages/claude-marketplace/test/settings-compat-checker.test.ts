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
 */

import * as fs from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { matchesDenyRule } from '../src/settings/permission-matcher.js';
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
  ['Write', 'Write(./secrets/**)', false],
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
  let fixture: SkillFixture;

  beforeAll(async () => {
    const pluginDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-compat-checker-'));
    const skillDir = safePath.join(pluginDir, 'skills', 's1');
    await fs.mkdir(skillDir, { recursive: true });
    fixture = { pluginDir, skillFile: safePath.join(skillDir, 'SKILL.md') };
  });

  afterAll(async () => {
    await fs.rm(fixture.pluginDir, { recursive: true, force: true });
  });

  const matcherBlocksSomeInput = (tool: string, rule: string): boolean =>
    PROBE_INPUTS.some((input) => matchesDenyRule(tool, input, rule, fixture.pluginDir));

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
        const blocked = await blockedTools(fixture, [spelling], rule);
        expect(blocked.length > 0, `${spelling} vs ${rule}`).toBe(
          matchesDenyRule(tool, input, rule, fixture.pluginDir)
        );
      }
    }
  });

  it('gives the matcher answer for the bare spelling', async () => {
    for (const [tool, rule, constrains] of RULES) {
      const blocked = await blockedTools(fixture, [tool], rule);
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
        fixture,
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
    expect(await blockedTools(fixture, tools, 'Write')).toEqual(tools);
  });

  // The other control: the consulted lanes are untouched by the fix, including
  // the bare spelling that used to CRASH the path lane with an empty path.
  it('still reports a consulted path rule and a Bash rule', async () => {
    expect(await blockedTools(fixture, ['Read', `Read(${SECRETS_KEY})`], READ_SECRETS)).toEqual([
      'Read',
      `Read(${SECRETS_KEY})`,
    ]);
    expect(await blockedTools(fixture, [`Read(${OUT_X})`], READ_SECRETS)).toEqual([]);
    expect(await blockedTools(fixture, ['Bash', `Bash(${RM_RF_ROOT})`], BASH_RM_STAR)).toEqual([
      'Bash',
      `Bash(${RM_RF_ROOT})`,
    ]);
    expect(await blockedTools(fixture, ['Bash(ls)'], BASH_RM_STAR)).toEqual([]);
  });
});
