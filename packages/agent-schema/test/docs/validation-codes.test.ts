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

/**
 * The VAT config mechanisms a remediation tells the reader to reach for.
 *
 * Deliberately NOT including the per-code severity override: every code has one,
 * so mentioning it on one side and not the other is elaboration, not a
 * contradiction. Everything here is a mechanism that either applies to this code
 * or does not, which is what makes a one-sided mention a genuine disagreement.
 */
function configMechanisms(text: string): string[] {
  const plain = text.replaceAll('`', '');
  const found = new Set<string>();
  if (/files:|skills\.config\.<name>\.files/i.test(plain)) found.add('files');
  if (/validation\.allow/i.test(plain)) found.add('validation.allow');
  if (/skills\.config\.<name>\.targets|declare targets/i.test(plain)) found.add('targets');
  if (/linkFollowDepth/i.test(plain)) found.add('linkFollowDepth');
  if (/excludeReferencesFromBundle/i.test(plain)) found.add('excludeReferencesFromBundle');
  if (/resourceNaming/i.test(plain)) found.add('resourceNaming');
  // The `exclude:` key on a marketplace plugin entry. Matched with the trailing
  // colon so it cannot collide with the prose verb ("or exclude via …") or with
  // `excludeReferencesFromBundle`, which is its own mechanism above.
  if (/(^|\s)exclude:/.test(plain)) found.add('plugin exclude');
  return [...found].sort((a, b) => a.localeCompare(b));
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

    // The registry `fix` is what a developer reads in the terminal; the doc's
    // "- **Fix:**" line is what they read when they follow the reference anchor.
    // Nothing kept the two from prescribing DIFFERENT remedies — and one release
    // shipped exactly that: the doc told authors to "drop the explicit `files:`
    // entry that named it" for a code whose dominant population (installed
    // third-party plugins) has no VAT config and no `files:` entry at all, while
    // the runtime string said something else entirely.
    //
    // Prose is not comparable word-for-word (measured: honest pairs share as
    // little as 23% of their content words, so any overlap threshold is noise).
    // What IS comparable is the set of VAT CONFIG MECHANISMS each remedy names —
    // that is the actionable part, and naming a mechanism the other side does not
    // is the drift that misdirects a reader.
    it(`${code}: doc and registry fix prescribe the same config mechanisms`, () => {
      const section = sectionFor(code) ?? '';
      const docFix = [...section.matchAll(/^- \*\*Fix:\*\*(.*)$/gm)].map((m) => m[1]).join(' ');
      expect(docFix, `\`${code}\` section has no "- **Fix:**" line`).not.toBe('');

      expect(configMechanisms(docFix), 'doc "- **Fix:**" line').toEqual(
        configMechanisms(CODE_REGISTRY[code].fix),
      );
    });
  }
});

/**
 * A remediation must be executable and must not describe a state that does not
 * hold. This code failed both at once, and the two halves failed together: the
 * description claimed the file "was excluded from the bundle" while the fix told
 * the reader to declare it under `files:` — and an adopter who did that got the
 * file SHIPPED (so the description was false) and the same build-failing error
 * (so the fix was unsatisfiable). Generic doc/registry coverage above cannot see
 * either: both strings were internally well-formed and mutually consistent.
 */
describe('LINK_TO_AGENT_INSTRUCTION_FILE remediation is executable', () => {
  const { fix, description } = CODE_REGISTRY.LINK_TO_AGENT_INSTRUCTION_FILE;

  it('offers the absolute-canonical-URL route', () => {
    expect(fix).toMatch(/absolute URL/i);
  });

  it('qualifies the files: route as an explicit, non-glob entry', () => {
    // Unqualified, it reads as advice a glob entry satisfies. It does not: a glob
    // is a net, not a declaration, and its matches are dropped by the
    // never-package filter, so the reader would "follow" the fix and see no change.
    expect(fix).toMatch(/explicit \(non-glob\) skills\.config\.<name>\.files/);
  });

  it('does not assert exclusion without the precondition that makes it true', () => {
    // An explicit files: entry ships the file, so a bare "it was excluded from the
    // bundle" is false exactly where the fix sends the reader.
    if (/excluded from the bundle|not bundled/i.test(description)) {
      expect(description).toMatch(/explicit files: entry/i);
    }
  });
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
