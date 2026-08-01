import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../../src/validation-codes.js';

const docsPath = fileURLToPath(new URL('../../../../docs/validation-codes.md', import.meta.url));
// Path is derived from `import.meta.url`, not user input — points at the
// repo's docs/validation-codes.md, the source of truth for code reference anchors.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const docs = readFileSync(docsPath, 'utf8');

const CODES = Object.keys(CODE_REGISTRY) as (keyof typeof CODE_REGISTRY)[];

/**
 * Slice the doc section belonging to one code: from its `### \`CODE\`` heading up
 * to the next heading at the same level or shallower (`### ` / `## ` / `# `).
 * `#### ` subheadings stay inside the section.
 */
function sectionFor(code: string): string | undefined {
  const start = docs.indexOf(`### \`${code}\``);
  if (start === -1) {
    return undefined;
  }
  const rest = docs.slice(start + 1);
  const end = /\n(?:### |## |# )/.exec(rest);
  return end === null ? rest : rest.slice(0, end.index);
}

describe('CODE_REGISTRY ↔ docs/validation-codes.md coverage', () => {
  for (const code of CODES) {
    it(`${code}: docs/validation-codes.md has the matching ### heading`, () => {
      expect(docs).toContain(`### \`${code}\``);
    });

    it(`${code}: entry.reference is the lowercased code anchor`, () => {
      const entry = CODE_REGISTRY[code];
      expect(entry.reference).toBe(`#${code.toLowerCase()}`);
    });

    // Without this, the registry and its own reference doc can silently disagree
    // about a code's default severity — and the doc is what adopters read when
    // deciding whether to override it.
    it(`${code}: doc's "**Default:**" line matches entry.defaultSeverity`, () => {
      const section = sectionFor(code);
      expect(section, `no ### \`${code}\` section in docs/validation-codes.md`).toBeDefined();

      const declared = /^- \*\*Default:\*\* `([a-z]+)`/m.exec(section ?? '');
      expect(
        declared,
        `\`${code}\` section has no "- **Default:** \`<severity>\`" line`,
      ).not.toBeNull();

      expect(declared?.[1]).toBe(CODE_REGISTRY[code].defaultSeverity);
    });
  }
});

describe('docs/validation-codes.md has no stale sections', () => {
  const headings = [...docs.matchAll(/^### `([A-Z][A-Z0-9_]*)`/gm)].map((match) => match[1]);

  // The forward direction (every code is documented) is covered above. This is the
  // reverse: a documented code that no longer exists in the registry is a section
  // adopters can still find and configure against, describing a code VAT never emits.
  it('every documented code still exists in CODE_REGISTRY', () => {
    const registryCodes = new Set<string>(CODES);
    const orphans = headings.filter((heading) => heading !== undefined && !registryCodes.has(heading));
    expect(orphans).toEqual([]);
  });

  it('documents each code exactly once', () => {
    const duplicates = headings.filter((heading, index) => headings.indexOf(heading) !== index);
    expect(duplicates).toEqual([]);
  });
});
