import { describe, expect, it } from 'vitest';

import { lf, recordsOf } from './core-helpers.js';

describe('mcpUnqualified', () => {
  it('records each bare code-span name the prose qualifies, once per line', () => {
    const text = lf(
      '---',
      'allowed-tools: mcp__gh__create_repo',
      '---',
      'Call `create_repo` then `get_me`.',
      'Use mcp__plugin_github_github__get_me.',
      '`get_me` is GitHub:get_me here',
      '`list_items` and `list_items` and `find`',
      'Server ListApi:list_items',
      'Trimmed ` get_me ` and `get_me` on one line',
    );
    expect(recordsOf(text, 'mcpUnqualified')).toEqual([
      ['mcp-code-span', 4, 'get_me'],
      ['mcp-code-span', 7, 'list_items'],
      ['mcp-code-span', 9, 'get_me'],
    ]);
  });

  it('takes no vocabulary from frontmatter', () => {
    const text = lf('---', 'allowed-tools: mcp__gh__create_repo', '---', 'Call `create_repo`.');
    expect(recordsOf(text, 'mcpUnqualified')).toEqual([]);
  });

  it('keeps an unterminated opening fence as body', () => {
    const text = lf('---', 'mcp__gh__create_repo', 'Call `create_repo`.');
    expect(recordsOf(text, 'mcpUnqualified')).toEqual([['mcp-code-span', 3, 'create_repo']]);
  });

  it('admits camelCase and kebab names, refuses one-word names', () => {
    const text = lf(
      'mcp__linear__createIssue mcp__c7__resolve-library-id mcp__chrome__find mcp__x__do_thing_',
      '`createIssue` `resolve-library-id` `find` `do_thing`',
    );
    expect(recordsOf(text, 'mcpUnqualified')).toEqual([
      ['mcp-code-span', 2, 'createIssue'],
      ['mcp-code-span', 2, 'resolve-library-id'],
      ['mcp-code-span', 2, 'do_thing'],
    ]);
  });

  it('refuses a lowercase or underscored API server', () => {
    const text = lf('node:child_process Foo_Bar:list_items', '`child_process` `list_items`');
    expect(recordsOf(text, 'mcpUnqualified')).toEqual([]);
  });

  it('reports a bare name on a line that qualifies another', () => {
    const text = lf('mcp__a__get_me mcp__a__list_items', '`get_me` with mcp__a__list_items and `list_items`');
    expect(recordsOf(text, 'mcpUnqualified')).toEqual([['mcp-code-span', 2, 'get_me']]);
  });
});
