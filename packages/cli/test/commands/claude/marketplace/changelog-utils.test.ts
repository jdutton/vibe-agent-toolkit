import { describe, expect, it } from 'vitest';

import {
  parseUnreleasedSection,
  parseVersionSection,
} from '../../../../src/commands/claude/marketplace/changelog-utils.js';

const SAMPLE_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- New marketplace publish command
- SPDX license shortcut support

### Fixed
- Version validation for plugins

## [0.1.0] - 2026-03-15

### Added
- Initial release
`;

const EMPTY_UNRELEASED = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-03-15

### Added
- Initial release
`;

const PRESTAMPED_CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-04-09

### Added
- New feature X
- New feature Y

## [1.1.0] - 2026-03-15

### Fixed
- Bug Z
`;

const PRESTAMPED_WITH_UNRELEASED_CONTENT = `# Changelog

## [Unreleased]

### Added
- Upcoming feature

## [1.2.0] - 2026-04-09

### Added
- Released feature
`;

describe('changelog-utils', () => {
  describe('parseUnreleasedSection', () => {
    it('should extract unreleased content', () => {
      const result = parseUnreleasedSection(SAMPLE_CHANGELOG);
      expect(result).toContain('### Added');
      expect(result).toContain('New marketplace publish command');
      expect(result).toContain('### Fixed');
      expect(result).not.toContain('## [0.1.0]');
    });

    it('should return empty string when unreleased section has no content', () => {
      const result = parseUnreleasedSection(EMPTY_UNRELEASED);
      expect(result.trim()).toBe('');
    });

    it('should return empty string when no unreleased section exists', () => {
      const result = parseUnreleasedSection('# Changelog\n\n## [1.0.0] - 2026-01-01\n');
      expect(result.trim()).toBe('');
    });
  });

  describe('parseVersionSection', () => {
    it('should extract content of a stamped version section', () => {
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '1.2.0');
      expect(result).toContain('### Added');
      expect(result).toContain('New feature X');
      expect(result).toContain('New feature Y');
      expect(result).not.toContain('## [1.1.0]');
      expect(result).not.toContain('Bug Z');
    });

    it('should extract the last version section (no following heading)', () => {
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '1.1.0');
      expect(result).toContain('### Fixed');
      expect(result).toContain('Bug Z');
    });

    it('should return empty string when the requested version is absent', () => {
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '9.9.9');
      expect(result.trim()).toBe('');
    });

    it('should not match substrings of other versions', () => {
      // '1.2' must NOT match '[1.2.0]' — we require exact version match
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '1.2');
      expect(result.trim()).toBe('');
    });

    it('should ignore the [Unreleased] section entirely', () => {
      const result = parseVersionSection(PRESTAMPED_WITH_UNRELEASED_CONTENT, '1.2.0');
      expect(result).toContain('Released feature');
      expect(result).not.toContain('Upcoming feature');
    });

    it('should handle versions with pre-release suffixes', () => {
      const changelog = `# Changelog\n\n## [Unreleased]\n\n## [1.2.0-rc.1] - 2026-04-09\n\n### Added\n- RC feature\n`;
      const result = parseVersionSection(changelog, '1.2.0-rc.1');
      expect(result).toContain('RC feature');
    });
  });
});
