/* eslint-disable @typescript-eslint/no-non-null-assertion -- Tests use non-null assertions after explicit length checks */
/* eslint-disable sonarjs/no-duplicate-string -- Test fixtures intentionally reuse literal body prose across cases */
/**
 * Unit tests for cross-skill-dependency-detection.ts
 *
 * SKILL_CROSS_SKILL_AUTH_UNDECLARED — detects skill body prose that states a
 * dependency on a sibling skill (backtick `plugin:skill`) or on an
 * ANTHROPIC_*_API_KEY / _KEY environment variable without declaring it in
 * the description.
 */

import { describe, expect, it } from 'vitest';

import { detectUndeclaredCrossSkillAuth } from '../../src/validators/cross-skill-dependency-detection.js';

function validFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'my-skill', description: 'Does something useful', ...overrides };
}

describe('detectUndeclaredCrossSkillAuth', () => {
  describe('sibling-skill dependencies', () => {
    it('fires when body requires a sibling skill that is not mentioned in the description', () => {
      const body = 'Requires `vibe-agent-toolkit:vat-enterprise-org` for authentication.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe('SKILL_CROSS_SKILL_AUTH_UNDECLARED');
      expect(issues[0]!.severity).toBe('warning');
      expect(issues[0]!.message).toContain('vat-enterprise-org');
    });

    it('does not fire when description names the required sibling skill', () => {
      const body = 'Requires `vibe-agent-toolkit:vat-enterprise-org` for authentication.';
      const fm = validFrontmatter({
        description: 'Queries organizational data. Requires vat-enterprise-org for auth.',
      });
      const issues = detectUndeclaredCrossSkillAuth(fm, body);

      expect(issues).toHaveLength(0);
    });

    it('handles the phrase-shard match (enterprise-org)', () => {
      const body = 'Requires `vibe-agent-toolkit:vat-enterprise-org` for authentication.';
      const fm = validFrontmatter({
        description: 'Queries org data. Requires the enterprise-org plugin.',
      });
      const issues = detectUndeclaredCrossSkillAuth(fm, body);

      expect(issues).toHaveLength(0);
    });

    it('deduplicates multiple mentions of the same skill', () => {
      const body =
        'Requires `plugin:auth-skill` for login. Also depends on `plugin:auth-skill` for logout.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);

      expect(issues).toHaveLength(1);
    });
  });

  describe('ANTHROPIC_*_API_KEY / _KEY dependencies', () => {
    it('fires when body requires ANTHROPIC_ADMIN_API_KEY not mentioned in description', () => {
      const body = 'Requires ANTHROPIC_ADMIN_API_KEY for admin endpoints.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('does not fire when description mentions the env var verbatim', () => {
      const body = 'Requires ANTHROPIC_ADMIN_API_KEY for admin endpoints.';
      const fm = validFrontmatter({
        description: 'Uses the Anthropic Admin API. Requires ANTHROPIC_ADMIN_API_KEY.',
      });
      const issues = detectUndeclaredCrossSkillAuth(fm, body);

      expect(issues).toHaveLength(0);
    });

    it('does not fire when description mentions "admin api key" (case-insensitive shard)', () => {
      const body = 'Requires ANTHROPIC_ADMIN_API_KEY for admin endpoints.';
      const fm = validFrontmatter({
        description: 'Uses the Anthropic admin API key to query org users.',
      });
      const issues = detectUndeclaredCrossSkillAuth(fm, body);

      expect(issues).toHaveLength(0);
    });

    it('deduplicates multiple mentions of the same env var', () => {
      const body =
        'Requires ANTHROPIC_ADMIN_API_KEY. Depends on ANTHROPIC_ADMIN_API_KEY for org endpoints.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);

      expect(issues).toHaveLength(1);
    });

    it('fires on "depends on" phrasing too', () => {
      const body = 'Depends on ANTHROPIC_WORKBENCH_API_KEY for workbench calls.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('ANTHROPIC_WORKBENCH_API_KEY');
    });

    it('does not fire on bare ANTHROPIC_API_KEY (universal default, not a cross-skill signal)', () => {
      const body = 'Requires `ANTHROPIC_API_KEY` to authenticate against the Claude API.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);

      expect(issues).toHaveLength(0);
    });
  });

  describe('negative cases', () => {
    it('does not fire on body with no dependency prose', () => {
      const body = 'This skill does plain things with no auth dependencies.';
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), body);
      expect(issues).toHaveLength(0);
    });

    it('does not fire on empty body', () => {
      const issues = detectUndeclaredCrossSkillAuth(validFrontmatter(), '');
      expect(issues).toHaveLength(0);
    });

    it('does not fire when description is missing (skip — handled by other validators)', () => {
      const body = 'Requires `plugin:auth` for auth.';
      const issues = detectUndeclaredCrossSkillAuth({ name: 'skill' }, body);
      // Without a description, we can't tell whether it's declared — be lenient.
      expect(issues).toHaveLength(0);
    });
  });
});
