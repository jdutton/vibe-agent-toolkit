/**
 * The fields `vat skills package` derives for its report: the skill's name, its
 * declared version, and a path relative to the working directory.
 */

import type { ParseResult } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { __internal } from '../../../src/commands/skills/package.js';

/** A parse result carrying only what the derivations read. */
function parsed(frontmatter: Record<string, unknown> | undefined, content = ''): ParseResult {
  return { frontmatter, content } as unknown as ParseResult;
}

describe('skills package report fields', () => {
  it('names the skill by frontmatter, then by its H1, else unknown', () => {
    expect(__internal.extractSkillName(parsed({ name: 'by-frontmatter' }, '# Heading'))).toBe('by-frontmatter');
    expect(__internal.extractSkillName(parsed(undefined, 'intro\n#  By Heading \nbody'))).toBe('By Heading');
    expect(__internal.extractSkillName(parsed({}, 'no heading'))).toBe('unknown');
  });

  it('publishes a declared version as a string, and null when none is declared', () => {
    expect(__internal.frontmatterVersion(parsed({ version: '1.2.0' }))).toBe('1.2.0');
    expect(__internal.frontmatterVersion(parsed({ version: 3 }))).toBe('3');
    expect(__internal.frontmatterVersion(parsed({ version: true }))).toBeNull();
    expect(__internal.frontmatterVersion(parsed(undefined))).toBeNull();
  });

  it('reports a path relative to the working directory, forward-slashed', () => {
    expect(__internal.reportPath(safePath.join(process.cwd(), 'dist', 'skills', 'x'))).toBe('dist/skills/x');
  });
});
