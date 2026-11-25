import { describe, expect, it } from 'vitest';

import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

import { lf, recordsOf } from './core-helpers.js';

describe('per document', () => {
  it.each([
    ['', 1],
    ['a', 1],
    ['a\nb\n', 3],
    ['a\r\nb', 2],
  ])('counts %j as %i lines, split on LF', (text, lineCount) => {
    expect(skillTextFactsOf(text, SKILL_TEXT_DECLARATION).lineCount).toBe(lineCount);
  });

  it.each([
    [lf('---', 'name: x', '---', '# Title ', 'body'), 'Title '],
    ['# Title \r\nbody', 'Title \r'],
    ['#\tTabbed', 'Tabbed'],
    ['#  ', ' '],
    ['# ', ''],
    ['##x\n## Two', null],
    ['no heading', null],
    [lf('text', '# First', '# Second'), 'First'],
  ])('captures the H1 of %j raw', (text, h1) => {
    expect(skillTextFactsOf(text, SKILL_TEXT_DECLARATION).h1).toBe(h1);
  });

  it('numbers records 0.. in emission order', () => {
    const facts = skillTextFactsOf(lf('as of March 2024', '${CLAUDE_PLUGIN_ROOT}', 'sed -i x'), SKILL_TEXT_DECLARATION);
    expect(facts.matches.map((match) => [match.ordinal, match.family])).toEqual([
      [0, 'timeSensitive'],
      [1, 'nonPortableAsset'],
      [2, 'nonPortableCommand'],
    ]);
  });
});

describe('timeSensitive', () => {
  it('records the first matching pattern per line', () => {
    const text = lf(
      'Data as of March 2024 here, after June 2023 too',
      'nothing here',
      'After june 2023 and as of 2024-05',
      'Valid until December 2030',
      'before january 2020',
      'as of 2024-05',
      'as of Smarch 2024',
    );
    expect(recordsOf(text, 'timeSensitive')).toEqual([
      ['as-of-month', 1, 'as of March 2024'],
      ['after-month', 3, 'After june 2023'],
      ['until-month', 4, 'until December 2030'],
      ['before-month', 5, 'before january 2020'],
      ['as-of-year-month', 6, 'as of 2024-05'],
    ]);
  });
});

describe('nonPortableAsset', () => {
  it('records the first matching variant per line, the match untrimmed', () => {
    const text = lf(
      'run ${CLAUDE_PLUGIN_ROOT}/x',
      '"${VAR:-$CLAUDE_PROJECT_DIR}"',
      'pwsh $Env:CLAUDE_SKILL_DIR',
      'cd /skills/my-skill && node scripts/run.mjs',
      'node /opt/x/run.mjs',
      '${CLAUDE_SKILL_DIR} and ${CLAUDE_PLUGIN_ROOT}',
      '~/.claude/skills/x/ is fine',
      'claude_plugin_root in prose',
    );
    expect(recordsOf(text, 'nonPortableAsset')).toEqual([
      ['claude-plugin-root', 1, '${CLAUDE_PLUGIN_ROOT}'],
      ['claude-project-dir', 2, '$CLAUDE_PROJECT_DIR'],
      ['claude-skill-dir', 3, '$Env:CLAUDE_SKILL_DIR'],
      ['api-skill-mount', 4, ' /skills/my-skill'],
      ['absolute-script-path', 5, 'node /opt/x/run.mjs'],
      ['claude-plugin-root', 6, '${CLAUDE_PLUGIN_ROOT}'],
    ]);
  });
});

describe('nonPortableCommand', () => {
  it('records the first matching variant per line, the match untrimmed', () => {
    const text = lf(
      '  timeout 5 cmd',
      'x | grep -P foo',
      'sed -i s/a/b/ f',
      'sed -i.bak s/a/b/ f',
      '`readlink -f x`',
      'date -d now',
      'the request will timeout',
    );
    expect(recordsOf(text, 'nonPortableCommand')).toEqual([
      ['timeout', 1, '  timeout 5'],
      ['grep-pcre', 2, '| grep -P'],
      ['sed-i-no-backup', 3, 'sed -i'],
      ['readlink-f', 5, '`readlink -f'],
      ['date-d', 6, 'date -d'],
    ]);
  });
});
