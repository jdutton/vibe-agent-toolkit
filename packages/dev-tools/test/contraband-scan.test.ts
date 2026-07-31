/**
 * Tests for the contraband-token scan.
 *
 * This test file is itself scanned by the gate it tests, so it must NEVER spell out a real
 * banned token. Every case below uses synthetic tokens — which is possible precisely
 * because the real list is injected from outside the repo rather than embedded in it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import {
  type ContrabandToken,
  loadTokens,
  parseTokenList,
  scanTextForContraband,
  TOKENS_DEFAULT_FILE,
  TOKENS_ENV,
  TOKENS_HOME_FILE,
} from '../src/contraband-scan.js';

const tempRoot = mkdtempSync(`${normalizedTmpdir()}/contraband-`);
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

/** The synthetic token every case is written against — never a real one. */
const TOKEN = 'zqwidget';

/** Write a token file at an absolute path and return it. */
function writeTokenFile(path: string, contents: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-owned temp path
  writeFileSync(path, contents, 'utf8');
  return path;
}

const tokens = (...raw: string[]): ContrabandToken[] => parseTokenList(raw.join('\n'));

describe('parseTokenList', () => {
  it('normalizes to bare lowercase alphanumerics', () => {
    expect(parseTokenList('ZQ-Widget')).toEqual([{ normalized: TOKEN, form: 'slug' }]);
  });

  it('classifies by how the token is written', () => {
    expect(parseTokenList('zqwidget\nzq-widget\nZQ Widget')).toEqual([
      { normalized: TOKEN, form: 'word' },
      { normalized: TOKEN, form: 'slug' },
      { normalized: TOKEN, form: 'phrase' },
    ]);
  });

  it('ignores comments, blank lines, and trailing comments', () => {
    expect(parseTokenList('# header\n\nzqwidget  # why\n   \n')).toEqual([
      { normalized: TOKEN, form: 'word' },
    ]);
  });

  it('drops tokens shorter than three characters', () => {
    expect(parseTokenList('zq\na\nzqw')).toEqual([{ normalized: 'zqw', form: 'word' }]);
  });
});

describe('word-form matching', () => {
  const list = tokens(TOKEN);

  it('flags the bare word', () => {
    expect(scanTextForContraband('we shipped zqwidget last week', list)).toEqual([
      { line: 1, form: 'word' },
    ]);
  });

  it('is case-insensitive', () => {
    expect(scanTextForContraband('ZQWidget and ZQWIDGET', list)).toEqual([{ line: 1, form: 'word' }]);
  });

  it('flags the word when wrapped in punctuation', () => {
    expect(scanTextForContraband('`zqwidget.py`, ./zqwidget', list)).toEqual([{ line: 1, form: 'word' }]);
  });

  it('does not flag a longer word that merely contains it', () => {
    expect(scanTextForContraband('the zqwidgetry department', list)).toEqual([]);
  });

  it('reports 1-indexed line numbers, at most one hit per line', () => {
    expect(scanTextForContraband('clean\nzqwidget zqwidget\nclean\nzqwidget', list)).toEqual([
      { line: 2, form: 'word' },
      { line: 4, form: 'word' },
    ]);
  });
});

describe('slug-form matching', () => {
  const list = tokens('reviewing-widgets');

  it.each(['reviewing-widgets', 'reviewing_widgets', 'reviewing.widgets', 'reviewing/widgets'])(
    'flags the punctuation-joined form %s',
    (slug) => {
      expect(scanTextForContraband(`see ${slug} for details`, list)).toEqual([{ line: 1, form: 'slug' }]);
    },
  );

  it('does NOT fire across a space — ordinary English must not trip the gate', () => {
    // The whole reason slug is a separate form from phrase.
    expect(scanTextForContraband('I spent the morning reviewing widgets.', list)).toEqual([]);
  });
});

describe('phrase-form matching', () => {
  it('flags a space-separated two-word phrase', () => {
    expect(scanTextForContraband('acquired by ZQWidget Corp in 2019', tokens('ZQWidget Corp'))).toEqual([
      { line: 1, form: 'phrase' },
    ]);
  });

  it('flags a four-word phrase', () => {
    const list = tokens('ZQ Widget Corp Holdings');
    expect(scanTextForContraband('the ZQ Widget Corp Holdings filing', list)).toEqual([
      { line: 1, form: 'phrase' },
    ]);
  });

  it('does not join across more than four words', () => {
    expect(scanTextForContraband('abc def ghi jkl mno', tokens('abc def ghi jkl mno'))).toEqual([]);
  });
});

describe('empty token list', () => {
  it('matches nothing rather than everything', () => {
    expect(scanTextForContraband('zqwidget zq-widget ZQ Widget', [])).toEqual([]);
  });
});

describe('hit shape', () => {
  it('carries only line and form — a report must never echo the name back', () => {
    const [hit] = scanTextForContraband(TOKEN, tokens(TOKEN));
    expect(hit).toBeDefined();
    expect(Object.keys(hit ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(['form', 'line']);
  });
});

describe('loadTokens', () => {
  /** A repo root that cannot exist, so only the explicitly-set source can be found. */
  const NO_REPO = '/nonexistent-repo';

  it('reads the env-configured file first', () => {
    const path = writeTokenFile(`${tempRoot}/env.txt`, `${TOKEN}\n`);
    const result = loadTokens(NO_REPO, { [TOKENS_ENV]: path });
    expect(result.path).toBe(path);
    expect(result.tokens).toEqual([{ normalized: TOKEN, form: 'word' }]);
  });

  it('throws when the env-configured file is unreadable — a typo must not look like a pass', () => {
    expect(() => loadTokens(NO_REPO, { [TOKENS_ENV]: `${tempRoot}/missing.txt` })).toThrow(
      /could not be read/,
    );
  });

  it('falls back to the gitignored repo-root file when no env var is set', () => {
    const repoRoot = mkdtempSync(`${normalizedTmpdir()}/contraband-repo-`);
    writeTokenFile(`${repoRoot}/${TOKENS_DEFAULT_FILE}`, 'zq-widget\n');
    const result = loadTokens(repoRoot, {});
    expect(result.path).toBe(`${repoRoot}/${TOKENS_DEFAULT_FILE}`);
    expect(result.tokens).toEqual([{ normalized: TOKEN, form: 'slug' }]);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('falls back to the per-machine home file, so every worktree is covered by one list', () => {
    const home = mkdtempSync(`${normalizedTmpdir()}/contraband-home-`);
    writeTokenFile(`${home}/${TOKENS_HOME_FILE}`, `${TOKEN}\n`);
    const result = loadTokens(NO_REPO, { HOME: home, USERPROFILE: home });
    expect(result.path).toBe(`${home}/${TOKENS_HOME_FILE}`);
    rmSync(home, { recursive: true, force: true });
  });

  it('returns an empty list with NO path when nothing is configured anywhere', () => {
    // The caller must treat this as "gate did not run", never as "repo is clean".
    const empty = `${tempRoot}/no-home`;
    const result = loadTokens(NO_REPO, { HOME: empty, USERPROFILE: empty });
    expect(result.tokens).toEqual([]);
    expect(result.path).toBeUndefined();
  });
});
