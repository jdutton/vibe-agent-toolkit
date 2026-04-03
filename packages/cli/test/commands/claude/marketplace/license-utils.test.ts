/* eslint-disable sonarjs/no-duplicate-string */
// Test file — duplicated string literals are acceptable for test readability
import { describe, expect, it } from 'vitest';

import {
  isFilePath,
  generateLicenseText,
  isSpdxIdentifier,
} from '../../../../src/commands/claude/marketplace/license-utils.js';

describe('license-utils', () => {
  describe('isFilePath', () => {
    it('should detect file paths with slashes', () => {
      expect(isFilePath('./LICENSE')).toBe(true);
      expect(isFilePath('docs/LICENSE-ENTERPRISE')).toBe(true);
    });

    it('should detect file paths with dots', () => {
      expect(isFilePath('LICENSE.txt')).toBe(true);
    });

    it('should not treat SPDX identifiers as file paths', () => {
      expect(isFilePath('mit')).toBe(false);
      expect(isFilePath('apache-2.0')).toBe(false);
      expect(isFilePath('gpl-3.0')).toBe(false);
    });
  });

  describe('isSpdxIdentifier', () => {
    it('should recognize common SPDX identifiers (case-insensitive)', () => {
      expect(isSpdxIdentifier('mit')).toBe(true);
      expect(isSpdxIdentifier('MIT')).toBe(true);
      expect(isSpdxIdentifier('apache-2.0')).toBe(true);
      expect(isSpdxIdentifier('Apache-2.0')).toBe(true);
      expect(isSpdxIdentifier('gpl-3.0')).toBe(true);
    });

    it('should reject unknown identifiers', () => {
      expect(isSpdxIdentifier('not-a-license')).toBe(false);
      expect(isSpdxIdentifier('./LICENSE')).toBe(false);
    });
  });

  describe('generateLicenseText', () => {
    it('should generate MIT license text with owner and year', () => {
      const text = generateLicenseText('mit', 'Test Org', 2026);
      expect(text).toContain('MIT License');
      expect(text).toContain('Test Org');
      expect(text).toContain('2026');
      expect(text).toContain('Permission is hereby granted');
    });

    it('should generate Apache 2.0 license text', () => {
      const text = generateLicenseText('apache-2.0', 'Test Org', 2026);
      expect(text).toContain('Apache License');
      expect(text).toContain('Version 2.0');
      expect(text).toContain('Test Org');
      expect(text).toContain('2026');
    });

    it('should throw for unknown SPDX identifier', () => {
      expect(() => generateLicenseText('unknown', 'Org', 2026)).toThrow();
    });
  });
});
