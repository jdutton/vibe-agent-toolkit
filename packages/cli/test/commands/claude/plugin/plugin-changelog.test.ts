/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePluginChangelogPath } from '../../../../src/commands/claude/plugin/plugin-changelog.js';
import { createTempDirTracker } from '../../../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-changelog-');

describe('resolvePluginChangelogPath', () => {
  afterEach(() => cleanupTempDirs());

  it('resolves config-supplied path when file exists', () => {
    const sourceDir = createTempDir();
    const customPath = safePath.join(sourceDir, 'docs', 'CHANGES.md');
    mkdirSyncReal(safePath.join(sourceDir, 'docs'), { recursive: true });
    writeFileSync(customPath, '# Changes\n');

    const result = resolvePluginChangelogPath(sourceDir, { changelog: 'docs/CHANGES.md' });
    expect(result).toBe(customPath);
  });

  it('returns undefined when config-supplied path does not exist', () => {
    const sourceDir = createTempDir();

    const result = resolvePluginChangelogPath(sourceDir, { changelog: 'missing/CHANGES.md' });
    expect(result).toBeUndefined();
  });

  it('resolves default <source>/CHANGELOG.md when file exists and no config provided', () => {
    const sourceDir = createTempDir();
    const defaultPath = safePath.join(sourceDir, 'CHANGELOG.md');
    writeFileSync(defaultPath, '# Changelog\n');

    const result = resolvePluginChangelogPath(sourceDir, {});
    expect(result).toBe(defaultPath);
  });

  it('returns undefined when no CHANGELOG.md exists and no config provided', () => {
    const sourceDir = createTempDir();

    const result = resolvePluginChangelogPath(sourceDir, {});
    expect(result).toBeUndefined();
  });

  it('treats empty changelog string as not provided and falls through to default', () => {
    const sourceDir = createTempDir();
    const defaultPath = safePath.join(sourceDir, 'CHANGELOG.md');
    writeFileSync(defaultPath, '# Changelog\n');

    const result = resolvePluginChangelogPath(sourceDir, { changelog: '' });
    expect(result).toBe(defaultPath);
  });
});
