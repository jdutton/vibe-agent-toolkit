import { describe, expect, it } from 'vitest';

import {
  isFilePath,
  generateLicenseText,
  isSpdxIdentifier,
  RENDERABLE_SPDX_IDS,
  UNRENDERABLE_SPDX_IDS,
} from '../../../../src/commands/claude/marketplace/license-utils.js';

/**
 * Phrases that prove the output is text *about* a license rather than the
 * license itself. `publish-tree.ts` writes this string verbatim as the LICENSE
 * file of a published marketplace, so a notice header or a one-line summary is
 * a legally void artifact — GPL-3.0 §4 and Apache-2.0 §4(a) both require
 * conveying a copy of the License with the work.
 */
const INCOMPLETE_LICENSE_TELLS: readonly [RegExp, string][] = [
  [/is licensed under the .+ license\./i, 'one-line summary instead of license terms'],
  [/You may obtain a copy of the License at/i, 'short-form notice pointing at external terms'],
  [/This Source Code Form is subject to the terms of/i, 'MPL notice header, not the license'],
];

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
    it('should recognize renderable SPDX identifiers (case-insensitive)', () => {
      expect(isSpdxIdentifier('mit')).toBe(true);
      expect(isSpdxIdentifier('MIT')).toBe(true);
      expect(isSpdxIdentifier('Mit')).toBe(true);
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

    // NOTE: the test this replaced asserted that `apache-2.0` "generates Apache
    // 2.0 license text". It passed against output that was only the short-form
    // notice header — the very artifact Apache-2.0 §4(a) says is not enough.
    it('should refuse apache-2.0 rather than emit a notice header', () => {
      expect(() => generateLicenseText('apache-2.0', 'Test Org', 2026))
        .toThrow(/cannot generate the full text/i);
    });

    it('should throw for unknown SPDX identifier', () => {
      expect(() => generateLicenseText('unknown', 'Org', 2026)).toThrow();
    });
  });

  /**
   * The invariant: `isSpdxIdentifier(x) === true` must imply
   * `generateLicenseText(x)` produces a legally complete license — for EVERY x.
   *
   * These tests iterate the tables. The previous suite named `mit` and
   * `apache-2.0` and vouched for 11 identifiers, 9 of which fell through to a
   * one-line stub and 1 of which emitted only a notice header.
   */
  describe('isSpdxIdentifier ⟹ generateLicenseText is complete', () => {
    it('recognizes exactly the identifiers VAT can render', () => {
      expect(RENDERABLE_SPDX_IDS.size).toBeGreaterThan(0);
      for (const id of RENDERABLE_SPDX_IDS.keys()) {
        expect(isSpdxIdentifier(id), `${id} should be recognized`).toBe(true);
      }
      for (const id of UNRENDERABLE_SPDX_IDS.keys()) {
        expect(isSpdxIdentifier(id), `${id} must not be vouched for`).toBe(false);
      }
    });

    it('keeps the renderable and unrenderable tables disjoint', () => {
      const overlap = [...RENDERABLE_SPDX_IDS.keys()].filter(id => UNRENDERABLE_SPDX_IDS.has(id));
      expect(overlap).toEqual([]);
    });

    it('keys both tables by the lowercased canonical identifier', () => {
      const mismatched = [...RENDERABLE_SPDX_IDS, ...UNRENDERABLE_SPDX_IDS]
        .filter(([key, canonical]) => key !== canonical.toLowerCase());
      expect(mismatched).toEqual([]);
    });

    for (const id of RENDERABLE_SPDX_IDS.keys()) {
      describe(id, () => {
        const text = generateLicenseText(id, 'Test Org', 2026);

        it('produces license terms, not a summary or a notice header', () => {
          const tells = INCOMPLETE_LICENSE_TELLS
            .filter(([pattern]) => pattern.test(text))
            .map(([, reason]) => reason);
          expect(tells).toEqual([]);
        });

        it('is long enough to contain a grant, conditions and a disclaimer', () => {
          expect(text.length).toBeGreaterThan(600);
        });

        it('grants rights and disclaims warranty in its own words', () => {
          expect(text).toMatch(/hereby grant|is hereby granted|permission is granted/i);
          expect(text).toMatch(/without warrant|as is|no warranty/i);
        });

        it('stamps the owner and year', () => {
          expect(text).toContain('Test Org');
          expect(text).toContain('2026');
        });

        it('is case-insensitive on the identifier', () => {
          expect(generateLicenseText(id.toUpperCase(), 'Test Org', 2026)).toBe(text);
        });
      });
    }

    for (const [id, canonical] of UNRENDERABLE_SPDX_IDS) {
      describe(id, () => {
        it('refuses with an actionable error instead of writing a void LICENSE', () => {
          let message = '';
          try {
            generateLicenseText(id, 'Test Org', 2026);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }

          // Names the identifier the user actually wrote.
          expect(message, `${id} must be refused, not rendered`).toContain(id);
          // Points at the remedy `resolveLicense` already supports.
          expect(message).toMatch(/file path|LICENSE file/i);
          // Points at where the canonical text comes from.
          expect(message).toContain(`spdx.org/licenses/${canonical}`);
        });
      });
    }
  });
});
