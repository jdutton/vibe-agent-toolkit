/**
 * Unit tests for `vat audit settings` output shaping.
 *
 * The command exists to answer "what is in effect here, and what did it
 * override?" — so the override chain is the one thing its formatter must not
 * drop.
 */

import type { ProvenanceValue, RuleConflict } from '@vibe-agent-toolkit/claude-marketplace';
import { describe, expect, it } from 'vitest';

import {
  formatProvenanceValue,
  formatSettingsPathEntry,
  settingsAuditFindings,
} from '../../src/commands/audit-settings.js';

const MANAGED_FILE = '/Library/Application Support/ClaudeCode/managed-settings.json';
const MANAGED_MODEL = 'managed-model';
const CURL_RULE = 'Bash(curl *)';
const USER_FILE = '/home/dev/.claude/settings.json';
const PROJECT_FILE = '/repo/.claude/settings.json';
/** The directory the command ran in — the report's one stated root. */
const ROOT = '/repo';

/** project overrides user overrides managed — the full three-link chain. */
const CHAIN: ProvenanceValue<string> = {
  value: 'project-model',
  provenance: { level: 'project', file: PROJECT_FILE },
  overrode: {
    value: 'user-model',
    provenance: { level: 'user', file: USER_FILE },
    overrode: {
      value: MANAGED_MODEL,
      provenance: { level: 'managed', file: MANAGED_FILE },
    },
  },
};

interface FormattedValue {
  value: unknown;
  source: string;
  level: string;
  locked?: boolean;
  overrode?: FormattedValue;
}

describe('formatProvenanceValue', () => {
  it('carries every link of the override chain into the output', () => {
    const out = formatProvenanceValue(CHAIN, ROOT) as FormattedValue;

    expect(out.value).toBe('project-model');
    expect(out.level).toBe('project');
    // Every source is spelled against the document's stated root, never absolutely.
    expect(out.source).toBe('.claude/settings.json');

    const second = out.overrode;
    expect(second).toBeDefined();
    expect(second?.value).toBe('user-model');
    expect(second?.level).toBe('user');
    expect(second?.source).toBe('../home/dev/.claude/settings.json');

    const third = second?.overrode;
    expect(third).toBeDefined();
    expect(third?.value).toBe(MANAGED_MODEL);
    expect(third?.level).toBe('managed');
    expect(third?.source).toBe('../Library/Application Support/ClaudeCode/managed-settings.json');
    // A managed link stays marked as locked wherever it appears in the chain.
    expect(third?.locked).toBe(true);
    expect(third?.overrode).toBeUndefined();
  });

  it('omits `overrode` entirely when the value overrode nothing', () => {
    const out = formatProvenanceValue({
      value: 'only-model',
      provenance: { level: 'user', file: USER_FILE },
    }, ROOT) as FormattedValue;

    expect(out).toEqual({ value: 'only-model', source: '../home/dev/.claude/settings.json', level: 'user' });
    expect('overrode' in out).toBe(false);
  });

  it('marks a managed top-level value as locked', () => {
    const out = formatProvenanceValue({
      value: MANAGED_MODEL,
      provenance: { level: 'managed', file: MANAGED_FILE },
    }, ROOT) as FormattedValue;

    expect(out.locked).toBe(true);
  });
});

describe('formatSettingsPathEntry', () => {
  const BASE = { label: 'User settings', path: USER_FILE, level: 'user' } as const;

  it('reports a determined answer as booleans', () => {
    expect(formatSettingsPathEntry({ ...BASE, exists: true, readable: true }, ROOT)).toEqual({
      label: 'User settings',
      path: '../home/dev/.claude/settings.json',
      exists: true,
      readable: true,
      level: 'user',
    });
  });

  it('reports an undetermined probe as undetermined, with the reason', () => {
    const out = formatSettingsPathEntry({
      ...BASE,
      exists: 'undetermined',
      readable: 'undetermined',
      accessError: 'EACCES',
    }, ROOT);

    expect(out['exists']).toBe('undetermined');
    expect(out['readable']).toBe('undetermined');
    expect(out['accessError']).toBe('EACCES');
  });

  it('leaves the legacy-path error to the report\'s findings — the entry carries no status of its own', () => {
    const out = formatSettingsPathEntry({
      label: 'Managed settings (Windows legacy — ERROR)',
      path: 'C:/ProgramData/ClaudeCode/managed-settings.json',
      level: 'managed',
      status: 'error',
      message: 'Legacy path',
      exists: true,
      readable: true,
    }, ROOT);

    // A `status: error` inside `data` would be a second status beside the envelope's.
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('message');
  });
});

describe('settingsAuditFindings', () => {
  const conflict: RuleConflict = {
    kind: 'shadowed-by-deny',
    rule: { rule: CURL_RULE, provenance: { level: 'project', file: PROJECT_FILE } },
    shadowedBy: { rule: CURL_RULE, provenance: { level: 'managed', file: MANAGED_FILE } },
  };

  it('reports nothing for a clean audit', () => {
    expect(settingsAuditFindings([], [], '/repo')).toEqual([]);
  });

  it('reports each conflict and each marketplace warning as a coded warning on the file that declares it', () => {
    const findings = settingsAuditFindings(
      [conflict],
      [{ message: 'GITHUB_TOKEN is not set', file: USER_FILE }],
      '/repo',
    );

    expect(findings.map((finding) => [finding.code, finding.severity])).toStrictEqual([
      ['SETTINGS_RULE_SHADOWED', 'warning'],
      ['SETTINGS_MARKETPLACE_TOKEN_MISSING', 'warning'],
    ]);
    expect(findings[0]?.message).toContain(CURL_RULE);
    // `location` is the file to open, relative to where the command ran.
    expect(findings[0]?.location).toBe('.claude/settings.json');
    expect(findings[1]?.message).toContain('GITHUB_TOKEN');
    expect(findings[1]?.location).toBe('../home/dev/.claude/settings.json');
  });
});
