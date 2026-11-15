/**
 * `claudeMemoryFactsOf` — the harness's content rules (`q7e`, `Sge`, `Ayn`),
 * pinned on the cases the loader differential's generator does not plant: the
 * `line` column, the BOM, the first-occurrence rule, and the `paths:` reader's
 * split and parse (its normaliser is pinned in `projection-claude-context-rules.test.ts`). What the differential
 * DOES plant — which tokens are imports, what is injected — is held there, against
 * an independent reference port.
 */

import { describe, expect, it } from 'vitest';

import { claudeMemoryFactsOf } from '../src/projection/claude-memory.js';

import { splitFrontmatter } from './helpers/claude-loader-reference.js';

/** Just the imports' `[target, line]` pairs. */
function importLines(raw: string): Array<[string, number]> {
  return claudeMemoryFactsOf(raw).imports.map((entry) => [entry.target, entry.line]);
}

describe('claudeMemoryFactsOf — imports', () => {
  it('reads each target once, at its first occurrence, in document order', () => {
    expect(claudeMemoryFactsOf('@b.md @a.md\n\n@b.md\n').imports.map((entry) => entry.target)).toEqual(['b.md', 'a.md']);
  });

  it('keeps the token as authored in rawRef and the resolvable spelling in target', () => {
    expect(claudeMemoryFactsOf(String.raw`@my\ file.md#top` + '\n').imports).toEqual([
      { rawRef: String.raw`@my\ file.md#top`, target: 'my file.md', line: 1 },
    ]);
  });

  it('reads nothing when there is no @ and no comment, without lexing', () => {
    expect(claudeMemoryFactsOf('plain text\n').imports).toEqual([]);
  });

  it('numbers lines of the FILE, frontmatter included', () => {
    expect(importLines('---\ntitle: t\n---\nIntro\n\n- @a.md\n- item **@b.md**\n')).toEqual([['a.md', 6], ['b.md', 7]]);
  });

  it('numbers a line inside a multi-line paragraph exactly', () => {
    expect(importLines('first line\nsecond @a.md\n')).toEqual([['a.md', 2]]);
  });

  it('gives a blockquote continuation the line its blockquote starts on', () => {
    // marked lexes the quote's content with the `> ` removed, so the inner
    // paragraph's text is not verbatim source — the column documents this.
    expect(importLines('\n> quote @a.md\n> more @b.md\n')).toEqual([['a.md', 2], ['b.md', 2]]);
  });

  it('strips a BOM before the frontmatter split, as `mE` does', () => {
    const bom = String.fromCodePoint(0xfe_ff);
    expect(importLines(`${bom}---\nx: 1\n---\n@a.md\n`)).toEqual([['a.md', 4]]);
  });
});

describe('claudeMemoryFactsOf — the injected measure', () => {
  it('removes frontmatter and block comments, keeps a comment\'s residue, and trims', () => {
    const facts = claudeMemoryFactsOf('---\nx: 1\n---\n<!-- gone --> kept\n\nBody.\n\n');
    expect(facts.injectedBytes).toBe(Buffer.byteLength('kept\n\nBody.'));
  });

  it('keeps a comment inside a code block', () => {
    const raw = '```\n<!-- kept -->\n```\n<!-- gone -->\n';
    expect(claudeMemoryFactsOf(raw).injectedBytes).toBe(Buffer.byteLength('```\n<!-- kept -->\n```'));
  });

  it('measures UTF-8 bytes and UTF-16 tokens of the same text', () => {
    const facts = claudeMemoryFactsOf('héllo\n');
    expect(facts.injectedBytes).toBe(6);
    expect(facts.injectedTokens).toBe(2);
  });

  it('measures zero for a file that injects nothing', () => {
    expect(claudeMemoryFactsOf('---\ndescription: d\n---\n<!-- @a.md -->\n')).toEqual({
      injectedBytes: 0,
      injectedTokens: 0,
      imports: [],
      paths: null,
    });
  });
});

describe('claudeMemoryFactsOf — the paths: the harness scopes a file by', () => {
  it('reads paths: off its OWN frontmatter split, whatever the content looks like', () => {
    // A `.ts` import: VAT's parser never sees it, the harness's `kyn` does.
    const source = '---\npaths:\n  - "src/**"\n  - "docs/**"\n---\nexport const x = 1;\n';
    expect(claudeMemoryFactsOf(source).paths).toEqual(['src/**', 'docs/**']);
  });

  it('reads a scalar paths: as a comma-split list', () => {
    expect(claudeMemoryFactsOf('---\npaths: "a/**, b/*.ts"\n---\nx\n').paths).toEqual(['a/**', 'b/*.ts']);
  });

  it('declares none for a file with no block, no paths:, or paths: that normalise to `**`', () => {
    expect(claudeMemoryFactsOf('paths: src/**\n').paths).toBeNull();
    expect(claudeMemoryFactsOf('---\ndescription: d\n---\nx\n').paths).toBeNull();
    expect(claudeMemoryFactsOf('---\npaths: ["**", "/**"]\n---\nx\n').paths).toBeNull();
  });

  it('declares none when the block is not YAML the parser accepts, and still splits the body off', () => {
    // `ts`: the body follows the match even when its YAML fails.
    const facts = claudeMemoryFactsOf('---\npaths: [unclosed\n---\nBody.\n');
    expect(facts.paths).toBeNull();
    expect(facts.injectedBytes).toBe('Body.'.length);
  });

  it('declares none for an alias bomb the YAML parser refuses to resolve', () => {
    const levels = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (const name of ['b', 'c', 'd', 'e', 'f']) {
      const previous = levels.at(-1)?.charAt(0) ?? 'a';
      const aliases = Array.from({ length: 9 }, () => `*${previous}`).join(',');
      levels.push(`${name}: &${name} [${aliases}]`);
    }
    expect(claudeMemoryFactsOf(`---\n${levels.join('\n')}\npaths: *f\n---\nx\n`).paths).toBeNull();
  });

  it('declares none when the block decodes to something other than a mapping', () => {
    expect(claudeMemoryFactsOf('---\n- paths\n---\nx\n').paths).toBeNull();
  });

  it('reads a key spelled with a YAML escape, which the literal-`paths` fast path must not skip', () => {
    expect(claudeMemoryFactsOf(String.raw`---
"p\x61ths": "src/**"
---
x
`).paths).toEqual(['src/**']);
  });

  it('matches `gB` after a BOM, as `mE` does', () => {
    expect(claudeMemoryFactsOf(`${String.fromCodePoint(0xfe_ff)}---\npaths: src/**\n---\nx\n`).paths).toEqual(['src/**']);
  });
});

/** Delimiter and whitespace characters — where the linear split and `gB` could part ways. */
const SPLIT_ALPHABET = ['-', '-', '-', '\n', '\n', ' ', '\t', '\r', String.fromCodePoint(0xa0), String.fromCodePoint(0x20_28), 'x'];

describe('claudeMemoryFactsOf — the linear frontmatter split agrees with `gB` verbatim', () => {
  it('injects the same text for every seeded string over delimiter and whitespace characters', () => {
    let state = 1;
    const next = (bound: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % bound;
    };
    for (let seed = 0; seed < 20_000; seed += 1) {
      const length = next(25);
      let text = next(2) === 0 ? '---' : '';
      for (let index = 0; index < length; index += 1) text += SPLIT_ALPHABET[next(SPLIT_ALPHABET.length)] ?? '';
      // The reference port runs the harness's regex verbatim.
      const expected = splitFrontmatter(text).content.trim();
      expect(claudeMemoryFactsOf(text).injectedBytes, JSON.stringify(text)).toBe(Buffer.byteLength(expected, 'utf8'));
    }
  });
});
