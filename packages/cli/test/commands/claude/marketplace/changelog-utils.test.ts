import { describe, expect, it } from 'vitest';

import {
  parseUnreleasedSection,
  stampChangelog,
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

  describe('stampChangelog', () => {
    it('should replace [Unreleased] with version and date', () => {
      const result = stampChangelog(SAMPLE_CHANGELOG, '0.2.0', '2026-04-01');
      expect(result).toContain('## [0.2.0] - 2026-04-01');
      expect(result).not.toContain('[Unreleased]');
      expect(result).toContain('New marketplace publish command');
    });

    it('should preserve content before and after unreleased section', () => {
      const result = stampChangelog(SAMPLE_CHANGELOG, '0.2.0', '2026-04-01');
      expect(result).toContain('# Changelog');
      expect(result).toContain('## [0.1.0] - 2026-03-15');
    });
  });
});
