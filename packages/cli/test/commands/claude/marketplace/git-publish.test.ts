import { describe, expect, it } from 'vitest';

import {
  createCommitMessage,
} from '../../../../src/commands/claude/marketplace/git-publish.js';

const HEADLINE_V1 = 'publish v1.0.0';

describe('git-publish', () => {
  describe('createCommitMessage', () => {
    it('should format commit message with headline and changelog delta', () => {
      const msg = createCommitMessage(HEADLINE_V1, '### Added\n- Feature A\n- Feature B');
      expect(msg).toContain(HEADLINE_V1);
      expect(msg).toContain('### Added');
      expect(msg).toContain('Feature A');
    });

    it('should include source repo metadata when provided', () => {
      const msg = createCommitMessage(HEADLINE_V1, '### Added\n- Feature', {
        sourceRepo: 'https://github.com/org/repo',
        commitRange: 'abc123..def456',
      });
      expect(msg).toContain('Source: https://github.com/org/repo');
      expect(msg).toContain('abc123..def456');
    });

    it('should work without changelog delta', () => {
      const msg = createCommitMessage(HEADLINE_V1, '');
      expect(msg).toContain(HEADLINE_V1);
    });

    it('should accept a headline without a version (multi-plugin marketplace)', () => {
      const msg = createCommitMessage('publish my-marketplace', '### Added\n- Bumped plugin-a');
      expect(msg.startsWith('publish my-marketplace')).toBe(true);
      expect(msg).not.toContain('publish v');
      expect(msg).toContain('Bumped plugin-a');
    });
  });
});
