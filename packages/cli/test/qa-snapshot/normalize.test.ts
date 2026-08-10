/**
 * Unit tests for QA-snapshot output normalization.
 *
 * The property under test throughout: two runs over an unchanged tree must
 * normalize to identical text, **and nothing beyond the measured instabilities
 * may be erased**. Several tests therefore carry a negative *and* a positive
 * control on the same fixture — an assertion that something was left alone is
 * worthless unless the same fixture proves the rewrite fires at all.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPathSubstitutions,
  normalizeCommandOutput,
  type NormalizeContext,
} from '../../src/qa-snapshot/normalize.js';

/** Shared by every context below; named so the literal appears exactly once. */
const HOME_DIR = '/Users/dev';

/** The vat root sits inside the home directory, which is the nesting that matters. */
const CONTEXT: NormalizeContext = {
  corpusRoot: `${HOME_DIR}/corpora/big-corpus`,
  vatRoot: `${HOME_DIR}/Workspaces/vibe-agent-toolkit`,
  homeDir: HOME_DIR,
};

/**
 * The three lines whose *normalized* spelling several tests assert.
 *
 * Named because `sonarjs/no-duplicate-string` groups literals by their trimmed
 * value, so every indented restatement of one of these counted against the same
 * literal. Indented variants are built from these by interpolation below.
 */
/** A YAML seconds duration, zeroed. */
const ZEROED_SECONDS_LINE = 'durationSecs: 0';
/** A YAML milliseconds duration, zeroed. */
const ZEROED_MS_LINE = 'duration: 0ms';
/** A scan count: a number the normalizer must leave completely alone. */
const FILE_COUNT_LINE = 'filesScanned: 1041';

/**
 * Normalize against the shared context unless a test supplies its own.
 *
 * @param text - Raw captured text.
 * @param context - Roots to erase; defaults to {@link CONTEXT}.
 * @returns The normalized text.
 */
function normalize(text: string, context: NormalizeContext = CONTEXT): string {
  return normalizeCommandOutput(text, context);
}

/**
 * Normalize a single line and drop the trailing newline the normalizer adds,
 * so a one-line expectation reads as a one-line string.
 *
 * @param line - A single line, without its newline.
 * @returns The normalized line.
 */
function normalizeLine(line: string): string {
  return normalize(line).trimEnd();
}

/** A realistic `vat resources scan` YAML capture. */
const YAML_FRAGMENT = [
  'status: success',
  `root: ${CONTEXT.corpusRoot}`,
  FILE_COUNT_LINE,
  'linksFound: 3894',
  'durationSecs: 12.481',
  'collections:',
  '  - id: systems',
  '    files: 212',
  '    duration: 412ms',
  '  - id: adrs',
  '    files: 37',
  '    duration: 88ms',
  'warnings: []',
  'notes:',
  `  - "resolved from ${CONTEXT.vatRoot}/packages/cli"`,
  '',
].join('\n');

/** A realistic `vat resources validate --format json` capture. */
const JSON_FRAGMENT = [
  '{',
  '  "status": "error",',
  `  "root": "${CONTEXT.corpusRoot}",`,
  '  "filesScanned": 1041,',
  '  "durationSecs": 3.902,',
  '  "errors": [',
  '    { "file": "docs/a.md", "message": "broken link" }',
  '  ],',
  `  "vatHome": "${CONTEXT.vatRoot}"`,
  '}',
  '',
].join('\n');

/** The three duration spellings, indented and unindented. */
const DURATION_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['unindented YAML seconds', 'durationSecs: 12.481', ZEROED_SECONDS_LINE],
  ['indented YAML seconds', '    durationSecs: 0.7', `    ${ZEROED_SECONDS_LINE}`],
  ['unindented YAML milliseconds', 'duration: 412ms', ZEROED_MS_LINE],
  ['indented YAML milliseconds', '  duration: 9ms', `  ${ZEROED_MS_LINE}`],
  ['indented JSON with a trailing comma', '  "durationSecs": 3.14,', '  "durationSecs": 0,'],
  ['unindented JSON without a comma', '"durationSecs": 3.902', '"durationSecs": 0'],
];

describe('normalizeCommandOutput — duration, the only field that varies between runs', () => {
  it.each(DURATION_CASES)('zeroes the %s duration', (_label, input, expected) => {
    expect(normalizeLine(input)).toBe(expected);
  });

  it('rewrites a duration only when it is the whole line, not when it is inside a value', () => {
    const input = ['message: "durationSecs: 12"', 'durationSecs: 12'].join('\n');

    expect(normalize(input)).toBe(
      ['message: "durationSecs: 12"', ZEROED_SECONDS_LINE, ''].join('\n'),
    );
  });

  it('leaves a number that is not a duration untouched', () => {
    expect(normalizeLine(FILE_COUNT_LINE)).toBe(FILE_COUNT_LINE);
  });
});

describe('normalizeCommandOutput — absolute paths', () => {
  it('prefers the nested root, so a vat root inside $HOME reads as <VATROOT> not <HOME>/…', () => {
    const text = `root: ${CONTEXT.vatRoot}/packages/cli\nhome: ${CONTEXT.homeDir}/notes\n`;

    expect(normalize(text)).toBe('root: <VATROOT>/packages/cli\nhome: <HOME>/notes\n');
  });

  it('substitutes a root containing regex metacharacters literally, and only that root', () => {
    const context: NormalizeContext = {
      corpusRoot: `${HOME_DIR}/a+b(c)`,
      vatRoot: '/opt/vat',
      homeDir: HOME_DIR,
    };
    const text = 'hit: /Users/dev/a+b(c)/docs\nmiss: /Users/dev/aab(c)/docs\n';

    expect(normalize(text, context)).toBe('hit: <CORPUS>/docs\nmiss: <HOME>/aab(c)/docs\n');
  });

  it('substitutes both the forward-slashed and the backslashed spelling of one root', () => {
    const context: NormalizeContext = {
      corpusRoot: String.raw`C:\corpora\big`,
      vatRoot: String.raw`C:\vat`,
      homeDir: String.raw`C:\Users\dev`,
    };
    const text = 'a: C:\\corpora\\big\\docs\nb: C:/corpora/big/docs\n';

    expect(normalize(text, context)).toBe('a: <CORPUS>\\docs\nb: <CORPUS>/docs\n');
  });

  it('treats a root given with a trailing separator as the same root', () => {
    const context: NormalizeContext = {
      corpusRoot: `${CONTEXT.corpusRoot}/`,
      vatRoot: CONTEXT.vatRoot,
      homeDir: CONTEXT.homeDir,
    };

    expect(normalize(`root: ${CONTEXT.corpusRoot}/docs\n`, context)).toBe('root: <CORPUS>/docs\n');
  });

  it('renders a vat root nested inside the corpus as corpus-relative, never as <VATROOT>', () => {
    // The primary use of the instrument: snapshotting VAT's own repo, where the
    // CLI binary that captured it lives inside the corpus being captured.
    const context: NormalizeContext = {
      corpusRoot: '/repo',
      vatRoot: '/repo/packages/cli',
      homeDir: HOME_DIR,
    };

    expect(normalize('bin: /repo/packages/cli/dist/bin.js\n', context)).toBe(
      'bin: <CORPUS>/packages/cli/dist/bin.js\n',
    );
  });

  it('keeps <VATROOT> for a sibling that merely shares a text prefix with the corpus', () => {
    // Falsifies the boundary check above: `/repo-other` is not inside `/repo`,
    // so a bare startsWith would wrongly collapse this into the corpus.
    const context: NormalizeContext = {
      corpusRoot: '/repo',
      vatRoot: '/repo-other/packages/cli',
      homeDir: HOME_DIR,
    };

    expect(normalize('bin: /repo-other/packages/cli/dist/bin.js\n', context)).toBe(
      'bin: <VATROOT>/dist/bin.js\n',
    );
  });

  it('erases the second copy of the root carried by the config-less fallback warning', () => {
    const warning = `no vibe-agent-toolkit.config.yaml or .git/ ancestor found; using ${CONTEXT.corpusRoot} as projectRoot`;

    expect(normalizeLine(warning)).toBe(
      'no vibe-agent-toolkit.config.yaml or .git/ ancestor found; using <CORPUS> as projectRoot',
    );
  });
});

describe('buildPathSubstitutions', () => {
  it('returns substitutions ordered longest-first', () => {
    const lengths = buildPathSubstitutions(CONTEXT).map((substitution) => substitution.from.length);

    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('places every vat-root spelling ahead of the home directory that contains it', () => {
    const substitutions = buildPathSubstitutions(CONTEXT);
    const lastVatRoot = substitutions.findLastIndex(({ to }) => to === '<VATROOT>');
    const firstHome = substitutions.findIndex(({ to }) => to === '<HOME>');

    expect(lastVatRoot).toBeLessThan(firstHome);
  });
});

describe('normalizeCommandOutput — line endings and idempotence', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normalize('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalize('a\rb')).toBe('a\nb\n');
  });

  it('adds a trailing newline only when the input had content', () => {
    expect(normalize('a')).toBe('a\n');
    expect(normalize('')).toBe('');
  });

  it.each([
    ['a YAML capture', YAML_FRAGMENT],
    ['a JSON capture', JSON_FRAGMENT],
    ['a CRLF capture with an unstable duration', 'a\r\ndurationSecs: 1.5\r\n'],
  ])('is idempotent over %s', (_label, sample) => {
    const once = normalize(sample);

    expect(normalize(once)).toBe(once);
  });
});

describe('normalizeCommandOutput — captures survive as parseable documents', () => {
  it('leaves a JSON capture parseable, with the roots and the duration replaced in place', () => {
    const parsed: unknown = JSON.parse(normalize(JSON_FRAGMENT));

    expect(parsed).toMatchObject({
      root: '<CORPUS>',
      durationSecs: 0,
      filesScanned: 1041,
      vatHome: '<VATROOT>',
      errors: [{ file: 'docs/a.md', message: 'broken link' }],
    });
  });

  it('leaves a YAML capture line-for-line intact apart from the roots and the durations', () => {
    const lines = normalize(YAML_FRAGMENT).split('\n').filter((line) => line.length > 0);

    expect(lines).toHaveLength(15);
    expect(lines[1]).toBe('root: <CORPUS>');
    expect(lines[4]).toBe(ZEROED_SECONDS_LINE);
    expect(lines.filter((line) => line.includes('duration:'))).toEqual([
      `    ${ZEROED_MS_LINE}`,
      `    ${ZEROED_MS_LINE}`,
    ]);
    expect(lines.at(-1)).toBe('  - "resolved from <VATROOT>/packages/cli"');
  });
});
