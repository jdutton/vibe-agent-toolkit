/**
 * Unit tests for determine-publish-tags.ts tag logic
 */
import semver from 'semver';
import { describe, expect, it } from 'vitest';

// Test version constants to avoid duplication
const RC_VERSION_1 = '1.0.0-rc.1';
const BETA_VERSION_1 = '2.0.0-beta.3';
const ALPHA_VERSION_1 = '1.0.0-alpha.1';

describe('Tag Determination Logic', () => {
  describe('Version Type Detection', () => {
    it('should identify stable versions', () => {
      const versions = ['1.0.0', '2.0.0', '1.2.3', '10.5.20'];

      for (const version of versions) {
        const isPrerelease = semver.prerelease(version) !== null;
        const isStable = !isPrerelease;

        expect(isStable).toBe(true);
        expect(isPrerelease).toBe(false);
      }
    });

    it('should identify prerelease versions', () => {
      const versions = [RC_VERSION_1, BETA_VERSION_1, ALPHA_VERSION_1, '3.0.0-next.5'];

      for (const version of versions) {
        const isPrerelease = semver.prerelease(version) !== null;
        const isStable = !isPrerelease;

        expect(isPrerelease).toBe(true);
        expect(isStable).toBe(false);
      }
    });

    it('should identify RC versions specifically', () => {
      const rcVersions = [RC_VERSION_1, '2.0.0-rc.5'];
      const nonRcVersions = ['1.0.0-beta.1', '1.0.0', '2.0.0-alpha.3'];

      for (const version of rcVersions) {
        const isPrerelease = semver.prerelease(version) !== null;
        const isRC = isPrerelease && version.includes('-rc');
        expect(isRC).toBe(true);
      }

      for (const version of nonRcVersions) {
        const isPrerelease = semver.prerelease(version) !== null;
        const isRC = isPrerelease && version.includes('-rc');
        expect(isRC).toBe(false);
      }
    });
  });

  describe('Primary Tag Selection', () => {
    it('should use "latest" tag for stable versions', () => {
      const stableVersions = ['1.0.0', '2.0.0', '1.5.3'];

      for (const version of stableVersions) {
        const isPrerelease = semver.prerelease(version) !== null;
        const isStable = !isPrerelease;
        const primaryTag = isStable ? 'latest' : 'next';

        expect(primaryTag).toBe('latest');
      }
    });

    it('should use "next" tag for prerelease versions', () => {
      const prereleaseVersions = [RC_VERSION_1, '2.0.0-beta.1', ALPHA_VERSION_1];

      for (const version of prereleaseVersions) {
        const isPrerelease = semver.prerelease(version) !== null;
        const isStable = !isPrerelease;
        const primaryTag = isStable ? 'latest' : 'next';

        expect(primaryTag).toBe('next');
      }
    });
  });

  describe('Version Comparison Logic', () => {
    it('should correctly compare versions for @next tag update', () => {
      // New stable version > current @next
      expect(semver.gt('1.0.0', RC_VERSION_1)).toBe(true);
      expect(semver.gt('2.0.0', '1.5.0')).toBe(true);

      // New stable version <= current @next
      expect(semver.gt('1.0.0', '1.0.0')).toBe(false);
      expect(semver.gt('1.0.0', '1.5.0')).toBe(false);
    });

    it('should handle edge cases in version comparison', () => {
      // Same version
      expect(semver.gt('1.0.0', '1.0.0')).toBe(false);

      // Prerelease vs stable
      expect(semver.gt('1.0.0', '0.9.9')).toBe(true);
      expect(semver.gt(RC_VERSION_1, '0.9.9')).toBe(true);

      // Different prerelease identifiers
      expect(semver.gt('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true);
      expect(semver.gt('1.0.0-beta.1', '1.0.0-alpha.1')).toBe(true);
    });
  });

  describe('Version Validation', () => {
    it('should validate correct semver versions', () => {
      const validVersions = ['1.0.0', '2.0.0-rc.1', '0.1.0', `10.5.20-beta.3`];

      for (const version of validVersions) {
        expect(semver.valid(version)).toBeTruthy();
      }
    });

    it('should reject invalid semver versions', () => {
      // Note: '1.0.0.0' flagged by sonarjs/no-hardcoded-ip but is a semver test case
      // eslint-disable-next-line sonarjs/no-hardcoded-ip
      const invalidVersions = ['1.0', '1.0.0.0', 'invalid', ''];

      for (const version of invalidVersions) {
        expect(semver.valid(version)).toBeNull();
      }
    });

    it('should coerce valid versions with prefix', () => {
      // semver.valid() coerces 'v1.0.0' to '1.0.0'
      expect(semver.valid('v1.0.0')).toBe('1.0.0');
      expect(semver.valid('v2.0.0-rc.1')).toBe('2.0.0-rc.1');
    });
  });
});
