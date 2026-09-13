/**
 * The generated blocks in `CLAUDE.md` are owned by `generate-claude-md.ts`.
 * These cases pin the marker grammar (indentation, unknown names, unclosed
 * blocks), the wrapping shape, and — on the real tree — that every registered
 * generator runs and every generator name has a block to fill.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import { CLAUDE_MD_GENERATORS, regenerateBlocks, wrapBacktickedList } from '../src/generate-claude-md.js';

describe('regenerateBlocks', () => {
  it('rewrites only what sits between markers and carries the marker indentation', () => {
    const doc = [
      'prose before',
      '- a list item:',
      '  <!-- gen:contributing-docs -->',
      '  stale',
      '  <!-- /gen:contributing-docs -->',
      'prose after',
    ].join('\n');

    const { text, changed, found } = regenerateBlocks(doc, PROJECT_ROOT);

    const lines = text.split('\n');
    expect(lines[0]).toBe('prose before');
    expect(lines.at(-1)).toBe('prose after');
    expect(lines[2]).toBe('  <!-- gen:contributing-docs -->');
    expect(lines[3]?.startsWith('  `')).toBe(true);
    expect(lines.at(-2)).toBe('  <!-- /gen:contributing-docs -->');
    expect(changed).toEqual(['contributing-docs']);
    expect(found).toEqual(['contributing-docs']);
  });

  it('reports no change when the block already holds the generated text', () => {
    const doc = ['<!-- gen:contributing-docs -->', 'x', '<!-- /gen:contributing-docs -->'].join('\n');
    const once = regenerateBlocks(doc, PROJECT_ROOT);

    const twice = regenerateBlocks(once.text, PROJECT_ROOT);

    expect(twice.changed).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it('refuses a marker with no generator rather than leaving it forever stale', () => {
    const doc = ['<!-- gen:no-such-block -->', '<!-- /gen:no-such-block -->'].join('\n');

    expect(() => regenerateBlocks(doc, PROJECT_ROOT)).toThrow(/no generator is registered for block "no-such-block"/);
  });

  it('refuses an unclosed block and a close with no open', () => {
    expect(() => regenerateBlocks('<!-- gen:contributing-docs -->\nx', PROJECT_ROOT)).toThrow(/never closed/);
    expect(() => regenerateBlocks('<!-- /gen:contributing-docs -->', PROJECT_ROOT)).toThrow(/close marker with no open/);
  });
});

describe('wrapBacktickedList', () => {
  it('joins names with commas and wraps before the column limit', () => {
    const names = Array.from({ length: 12 }, (_, index) => `name-number-${index}`);

    const lines = wrapBacktickedList(names, 2);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(2 + line.length).toBeLessThanOrEqual(100);
    expect(lines.join(' ')).toBe(names.map((name, index) => `\`${name}\`${index < 11 ? ',' : ''}`).join(' '));
  });
});

describe('the real CLAUDE.md', () => {
  const text = readFileSync(safePath.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf8');

  it('carries one block for every registered generator, and every generator produces content', () => {
    const { found } = regenerateBlocks(text, PROJECT_ROOT);

    expect([...found].sort((a, b) => a.localeCompare(b))).toEqual(Object.keys(CLAUDE_MD_GENERATORS).sort((a, b) => a.localeCompare(b)));
    for (const [name, generate] of Object.entries(CLAUDE_MD_GENERATORS)) {
      expect(generate(PROJECT_ROOT).length, `${name} generated nothing`).toBeGreaterThan(0);
    }
  });

  it('lists every resolveAssetReference call site under packages/*/src', () => {
    // Pinned as a property rather than a count: the definition site is not a
    // call site, and every listed file must actually call the function.
    const lines = CLAUDE_MD_GENERATORS['asset-reference-sites']?.(PROJECT_ROOT) ?? [];
    for (const line of lines) {
      const rel = /`([^`]+)`/.exec(line)?.[1] ?? '';
      const source = readFileSync(safePath.join(PROJECT_ROOT, rel), 'utf8');
      expect(source).toContain('resolveAssetReference(');
      expect(source).not.toContain('function resolveAssetReference(');
    }
    expect(lines.some((line) => line.includes('packages/utils/src/asset-reference.ts'))).toBe(false);
  });
});
