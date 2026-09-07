/**
 * The WIRING of `MCP_TOOL_NAME_UNQUALIFIED` into the CONFIG-FREE validation
 * lane — `validateSkill`, the validator every skill without a governing
 * `vibe-agent-toolkit.config.yaml` is audited by.
 *
 * 🚨 This file exists because the detector shipped reachable from exactly one
 * lane. `collectUnqualifiedMcpToolIssues` had two call sites, both inside
 * `validateSkillForPackaging`, so `vat audit` only ever ran it on skills that
 * sat under a VAT config. Every INSTALLED skill — `~/.claude/plugins/**`,
 * `~/.claude/skills/**` — takes the config-free lane instead, which meant the
 * check could not fire on the corpus its precision table was measured on.
 * Measured on 851 installed skills: the shipped command emitted the code 0
 * times while the detector, driven directly over the same files, had findings
 * to report. Wiring both lanes took the run to 29 occurrences across 8
 * documents with no other code's count moving.
 *
 * That is the same class as `built-phase-checks-are-wired.integration.test.ts`
 * one layer up: a detector measured through one path and shipped down another,
 * invisible because nothing compared the two lanes' code sets. The unit suite
 * `mcp-tool-qualification.test.ts` drives the detector directly and therefore
 * cannot see this at all — it stays green with both call lines deleted.
 *
 * So the assertions here are about the CHANNEL, not the logic: that a
 * config-free `validateSkill` run reaches the detector for the SKILL.md body
 * AND for a linked resource file. Deleting either production call line must
 * turn one of these red.
 */

import { describe, expect, it } from 'vitest';

import {
  createSkillAndValidate,
  createSkillContent,
  createTransitiveSkillStructure,
  expectWarning,
  setupTempDir,
  validateSkillWithTransitiveChecking,
} from '../test-helpers.js';

/**
 * A body that names one tool both fully-qualified and bare. The bare mention is
 * the finding; the qualified one is the detector's premise — it only fires on a
 * document that contradicts itself, so both spellings must be present.
 */
const SELF_CONTRADICTING_BODY = [
  '# Demo',
  '',
  'Call `mcp__demo__run_thing` to start the job.',
  '',
  'If it fails, retry with `run_thing` and a longer timeout.',
].join('\n');

describe('MCP_TOOL_NAME_UNQUALIFIED reaches the config-free lane', () => {
  const { getTempDir } = setupTempDir('mcp-config-free-');

  it('fires on SKILL.md through validateSkill, with no VAT config anywhere', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'demo', description: 'A fixture skill for the config-free MCP wiring test.' },
        SELF_CONTRADICTING_BODY,
      ),
    );

    expectWarning(result, 'MCP_TOOL_NAME_UNQUALIFIED');

    // Anchored on the bare identifier, not just the file: that `link` payload is
    // what lets an adopter waive one tool name rather than the whole document.
    const issue = result.issues.find((i) => i.code === 'MCP_TOOL_NAME_UNQUALIFIED');
    expect(issue?.link).toBe('run_thing');
  });

  it('fires on a LINKED resource file, not only on SKILL.md', async () => {
    const tempDir = getTempDir();
    const { skillPath } = createTransitiveSkillStructure(
      tempDir,
      { 'resources/usage.md': `# Usage\n\n${SELF_CONTRADICTING_BODY}\n` },
      createSkillContent(
        { name: 'demo', description: 'A fixture skill whose bare tool names live in a linked file.' },
        '# Demo\n\nSee [usage](resources/usage.md) for the call sequence.\n',
      ),
    );

    const result = await validateSkillWithTransitiveChecking(skillPath, tempDir);

    expectWarning(result, 'MCP_TOOL_NAME_UNQUALIFIED');

    // The finding must be anchored on the LINKED file. Anchoring it on SKILL.md
    // would send a reader to a document that never names the tool, and would
    // also pass if only the SKILL.md call line existed.
    const issue = result.issues.find((i) => i.code === 'MCP_TOOL_NAME_UNQUALIFIED');
    expect(issue?.location).toContain('usage.md');
  });

  it('stays silent when every mention is already qualified', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'demo', description: 'A fixture skill that spells every tool name in full.' },
        '# Demo\n\nCall `mcp__demo__run_thing`, then `mcp__demo__run_thing` again.\n',
      ),
    );

    expect(result.issues.filter((i) => i.code === 'MCP_TOOL_NAME_UNQUALIFIED')).toHaveLength(0);
  });
});
