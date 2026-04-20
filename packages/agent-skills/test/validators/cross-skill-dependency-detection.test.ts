/* eslint-disable @typescript-eslint/no-non-null-assertion -- Tests use non-null assertions after explicit length checks */
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

const BODY_REQUIRES_ENTERPRISE_ORG =
  'Requires `vibe-agent-toolkit:vat-enterprise-org` for authentication.';
const BODY_REQUIRES_ADMIN_API_KEY =
  'Requires ANTHROPIC_ADMIN_API_KEY for admin endpoints.';

/**
 * Run the detector against a body with an optional `description` override,
 * using the standard baseline frontmatter (`name: my-skill`,
 * `description: Does something useful`). Keeps tests focused on what the
 * body-plus-description combination detects, not on fixture construction.
 */
function detect(
  body: string,
  descriptionOverride?: string,
): ReturnType<typeof detectUndeclaredCrossSkillAuth> {
  const fm: Record<string, unknown> = {
    name: 'my-skill',
    description: descriptionOverride ?? 'Does something useful',
  };
  return detectUndeclaredCrossSkillAuth(fm, body);
}

describe('detectUndeclaredCrossSkillAuth', () => {
  describe('sibling-skill dependencies', () => {
    it('fires when body requires a sibling skill that is not mentioned in the description', () => {
      const issues = detect(BODY_REQUIRES_ENTERPRISE_ORG);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe('SKILL_CROSS_SKILL_AUTH_UNDECLARED');
      expect(issues[0]!.severity).toBe('warning');
      expect(issues[0]!.message).toContain('vat-enterprise-org');
    });

    it('does not fire when description names the required sibling skill', () => {
      const issues = detect(
        BODY_REQUIRES_ENTERPRISE_ORG,
        'Queries organizational data. Requires vat-enterprise-org for auth.',
      );
      expect(issues).toHaveLength(0);
    });

    it('handles the phrase-shard match (enterprise-org)', () => {
      const issues = detect(
        BODY_REQUIRES_ENTERPRISE_ORG,
        'Queries org data. Requires the enterprise-org plugin.',
      );
      expect(issues).toHaveLength(0);
    });

    it('deduplicates multiple mentions of the same skill', () => {
      const issues = detect(
        'Requires `plugin:auth-skill` for login. Also depends on `plugin:auth-skill` for logout.',
      );
      expect(issues).toHaveLength(1);
    });
  });

  describe('ANTHROPIC_*_API_KEY / _KEY dependencies', () => {
    it('fires when body requires ANTHROPIC_ADMIN_API_KEY not mentioned in description', () => {
      const issues = detect(BODY_REQUIRES_ADMIN_API_KEY);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('does not fire when description mentions the env var verbatim', () => {
      const issues = detect(
        BODY_REQUIRES_ADMIN_API_KEY,
        'Uses the Anthropic Admin API. Requires ANTHROPIC_ADMIN_API_KEY.',
      );
      expect(issues).toHaveLength(0);
    });

    it('does not fire when description mentions "admin api key" (case-insensitive shard)', () => {
      const issues = detect(
        BODY_REQUIRES_ADMIN_API_KEY,
        'Uses the Anthropic admin API key to query org users.',
      );
      expect(issues).toHaveLength(0);
    });

    it('deduplicates multiple mentions of the same env var', () => {
      const issues = detect(
        'Requires ANTHROPIC_ADMIN_API_KEY. Depends on ANTHROPIC_ADMIN_API_KEY for org endpoints.',
      );
      expect(issues).toHaveLength(1);
    });

    it('fires on "depends on" phrasing too', () => {
      const issues = detect('Depends on ANTHROPIC_WORKBENCH_API_KEY for workbench calls.');

      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('ANTHROPIC_WORKBENCH_API_KEY');
    });

    it('does not fire on bare ANTHROPIC_API_KEY (universal default, not a cross-skill signal)', () => {
      const issues = detect(
        'Requires `ANTHROPIC_API_KEY` to authenticate against the Claude API.',
      );
      expect(issues).toHaveLength(0);
    });
  });

  describe('negative cases', () => {
    it('does not fire on body with no dependency prose', () => {
      const issues = detect('This skill does plain things with no auth dependencies.');
      expect(issues).toHaveLength(0);
    });

    it('does not fire on empty body', () => {
      const issues = detect('');
      expect(issues).toHaveLength(0);
    });

    it('does not fire when description is missing (skip — handled by other validators)', () => {
      // Without a description, we can't tell whether it's declared — be lenient.
      const issues = detectUndeclaredCrossSkillAuth(
        { name: 'skill' },
        'Requires `plugin:auth` for auth.',
      );
      expect(issues).toHaveLength(0);
    });
  });
});
