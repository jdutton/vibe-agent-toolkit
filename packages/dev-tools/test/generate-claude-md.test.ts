/**
 * The generated blocks in `CLAUDE.md` and its sibling documents are owned by
 * `generate-claude-md.ts`. These cases pin the marker grammar (indentation,
 * unknown names, unclosed blocks), the wrapping shape, and — on the real tree —
 * that every registered generator runs, every generator name is claimed by
 * exactly one document, and every document carries the blocks it claims.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import { CLAUDE_MD_GENERATORS, GENERATED_DOCUMENTS, regenerateBlocks, regenerateDocument, wrapBacktickedList } from '../src/generate-claude-md.js';

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

describe('the real generated documents', () => {
  it('claim every registered generator exactly once, and every generator produces content', () => {
    const claimed = GENERATED_DOCUMENTS.flatMap((document) => document.blocks);

    expect([...claimed].sort((a, b) => a.localeCompare(b))).toEqual(Object.keys(CLAUDE_MD_GENERATORS).sort((a, b) => a.localeCompare(b)));
    for (const [name, generate] of Object.entries(CLAUDE_MD_GENERATORS)) {
      expect(generate(PROJECT_ROOT).length, `${name} generated nothing`).toBeGreaterThan(0);
    }
  });

  it.each(GENERATED_DOCUMENTS.map((document) => [document.path, document] as const))(
    '%s carries exactly the blocks it claims',
    (_path, document) => {
      const { result, missing } = regenerateDocument(PROJECT_ROOT, document);

      expect(missing).toEqual([]);
      expect([...result.found].sort((a, b) => a.localeCompare(b))).toEqual([...document.blocks].sort((a, b) => a.localeCompare(b)));
    },
  );

  it('names the document in a marker error', () => {
    const doc = { path: 'docs/does-not-matter.md', blocks: ['contributing-docs'] };
    expect(() => regenerateBlocks('<!-- gen:no-such-block -->\nx\n<!-- /gen:no-such-block -->', PROJECT_ROOT, doc.path)).toThrow(
      /^docs\/does-not-matter\.md:1: no generator/,
    );
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
