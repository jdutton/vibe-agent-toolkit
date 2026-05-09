import { describe, expect, it } from 'vitest';

import { pluginTagName } from '../../../../src/commands/claude/marketplace/tag-utils.js';

describe('pluginTagName', () => {
  it('formats <plugin>-v<version> for normal inputs', () => {
    expect(pluginTagName('ai-digest', '0.2.0')).toBe('ai-digest-v0.2.0');
  });

  it('passes through prerelease version strings', () => {
    expect(pluginTagName('foo', '1.0.0-rc.1')).toBe('foo-v1.0.0-rc.1');
  });

  it('throws on empty plugin name', () => {
    expect(() => pluginTagName('', '0.1.0')).toThrow(/name/i);
  });

  it('throws on empty version', () => {
    expect(() => pluginTagName('foo', '')).toThrow(/version/i);
  });
});
