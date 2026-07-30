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
    const out = formatProvenanceValue(CHAIN) as FormattedValue;

    expect(out.value).toBe('project-model');
    expect(out.level).toBe('project');
    expect(out.source).toBe(PROJECT_FILE);

    const second = out.overrode;
    expect(second).toBeDefined();
    expect(second?.value).toBe('user-model');
    expect(second?.level).toBe('user');
    expect(second?.source).toBe(USER_FILE);

    const third = second?.overrode;
    expect(third).toBeDefined();
    expect(third?.value).toBe(MANAGED_MODEL);
    expect(third?.level).toBe('managed');
    expect(third?.source).toBe(MANAGED_FILE);
    // A managed link stays marked as locked wherever it appears in the chain.
    expect(third?.locked).toBe(true);
    expect(third?.overrode).toBeUndefined();
  });

  it('omits `overrode` entirely when the value overrode nothing', () => {
    const out = formatProvenanceValue({
      value: 'only-model',
      provenance: { level: 'user', file: USER_FILE },
    }) as FormattedValue;

    expect(out).toEqual({ value: 'only-model', source: USER_FILE, level: 'user' });
    expect('overrode' in out).toBe(false);
  });

  it('marks a managed top-level value as locked', () => {
    const out = formatProvenanceValue({
      value: MANAGED_MODEL,
      provenance: { level: 'managed', file: MANAGED_FILE },
    }) as FormattedValue;

    expect(out.locked).toBe(true);
  });
});

describe('formatSettingsPathEntry', () => {
  const BASE = { label: 'User settings', path: USER_FILE, level: 'user' } as const;

  it('reports a determined answer as booleans', () => {
    expect(formatSettingsPathEntry({ ...BASE, exists: true, readable: true })).toEqual({
      label: 'User settings',
      path: USER_FILE,
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
    });

    expect(out['exists']).toBe('undetermined');
    expect(out['readable']).toBe('undetermined');
    expect(out['accessError']).toBe('EACCES');
  });

  it('keeps the legacy-path error status', () => {
    const out = formatSettingsPathEntry({
      label: 'Managed settings (Windows legacy — ERROR)',
      path: 'C:/ProgramData/ClaudeCode/managed-settings.json',
      level: 'managed',
      status: 'error',
      message: 'Legacy path',
      exists: true,
      readable: true,
    });

    expect(out['status']).toBe('error');
    expect(out['message']).toBe('Legacy path');
  });
});

describe('settingsAuditFindings', () => {
  const conflict: RuleConflict = {
    kind: 'shadowed-by-deny',
    rule: { rule: CURL_RULE, provenance: { level: 'project', file: PROJECT_FILE } },
    shadowedBy: { rule: CURL_RULE, provenance: { level: 'managed', file: MANAGED_FILE } },
  };

  it('reports nothing for a clean audit', () => {
    expect(settingsAuditFindings([], [])).toEqual([]);
  });

  it('reports each conflict and each marketplace warning as a warning finding', () => {
    const findings = settingsAuditFindings([conflict], ['GITHUB_TOKEN is not set']);

    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.severity).toBe('warning');
      expect(typeof finding.message).toBe('string');
      expect(finding.message.length).toBeGreaterThan(0);
    }
    expect(findings[0]?.message).toContain(CURL_RULE);
    expect(findings[1]?.message).toContain('GITHUB_TOKEN');
  });
});
