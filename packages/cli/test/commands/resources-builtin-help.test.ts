/**
 * `vat resources check --help` tells an adopter two things about the built-ins
 * that must stay true: a block of YAML to paste into `resources.checks`, and
 * which code and default severity each built-in emits. Both are RENDERED from
 * `BUILTIN_CHECKS`; these cases pin that the rendering is valid, not merely
 * present.
 */

import { BUILTIN_CHECKS, ProjectConfigSchema } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { builtinCheckList, builtinSqlTwins } from '../../src/commands/resources/builtin-help.js';

describe('resources check --help built-in rendering', () => {
  it('renders SQL twins an adopter can paste as a valid config', () => {
    // The help indents the block four spaces; a paste drops that indent.
    const pasted = builtinSqlTwins().split('\n').map((line) => line.slice(4)).join('\n');
    const parsed: unknown = yaml.parse(pasted);

    const config = ProjectConfigSchema.parse(parsed);
    const checks = config.resources?.checks ?? {};
    // Positive control: every built-in arrived, with its description intact —
    // an unquoted `paths: ` inside a description parses as a nested map.
    expect(Object.keys(checks)).toEqual(BUILTIN_CHECKS.map((check) => `my-${check.name}`));
    for (const check of BUILTIN_CHECKS) {
      expect(checks[`my-${check.name}`]?.description).toBe(check.description);
      expect(checks[`my-${check.name}`]?.sql.trim()).toBe(check.sqlTwin.trim());
    }
  });

  it('names each built-in with the code and registry default severity it emits', () => {
    const list = builtinCheckList();

    for (const check of BUILTIN_CHECKS) {
      expect(list).toContain(check.name);
      expect(list).toContain(`${check.code} (default: ${CODE_REGISTRY[check.code].defaultSeverity})`);
    }
  });
});
