import { describe, expect, it } from 'vitest';

import { detectKebabCaseViolation } from '../../src/validators/kebab-case-detection.js';

const LOC = '/some/file.json';

describe('detectKebabCaseViolation', () => {
  describe('plugin variant', () => {
    it('returns undefined for valid kebab-case', () => {
      expect(detectKebabCaseViolation('plugin', 'my-plugin', LOC)).toBeUndefined();
      expect(detectKebabCaseViolation('plugin', 'a', LOC)).toBeUndefined();
      expect(detectKebabCaseViolation('plugin', 'one-two-three', LOC)).toBeUndefined();
      expect(detectKebabCaseViolation('plugin', 'with9digits', LOC)).toBeUndefined();
    });

    it('emits PLUGIN_NAME_NOT_KEBAB_CASE for uppercase names', () => {
      const issue = detectKebabCaseViolation('plugin', 'My_Plugin', LOC);
      expect(issue?.code).toBe('PLUGIN_NAME_NOT_KEBAB_CASE');
      expect(issue?.severity).toBe('info');
      expect(issue?.location).toBe(LOC);
    });

    it('emits PLUGIN_NAME_NOT_KEBAB_CASE for trailing/leading hyphens', () => {
      expect(detectKebabCaseViolation('plugin', '-leading', LOC)?.code).toBe('PLUGIN_NAME_NOT_KEBAB_CASE');
      expect(detectKebabCaseViolation('plugin', 'trailing-', LOC)?.code).toBe('PLUGIN_NAME_NOT_KEBAB_CASE');
      expect(detectKebabCaseViolation('plugin', 'double--hyphen', LOC)?.code).toBe('PLUGIN_NAME_NOT_KEBAB_CASE');
    });

    it('emits PLUGIN_NAME_NOT_KEBAB_CASE for underscores and dots', () => {
      expect(detectKebabCaseViolation('plugin', 'snake_case', LOC)?.code).toBe('PLUGIN_NAME_NOT_KEBAB_CASE');
      expect(detectKebabCaseViolation('plugin', 'dot.name', LOC)?.code).toBe('PLUGIN_NAME_NOT_KEBAB_CASE');
    });
  });

  describe('skill variant', () => {
    it('emits SKILL_NAME_NOT_KEBAB_CASE for uppercase', () => {
      const issue = detectKebabCaseViolation('skill', 'MySkill', LOC);
      expect(issue?.code).toBe('SKILL_NAME_NOT_KEBAB_CASE');
      expect(issue?.severity).toBe('info');
    });

    it('returns undefined for empty string (defer to other validators)', () => {
      expect(detectKebabCaseViolation('skill', '', LOC)).toBeUndefined();
    });
  });
});
